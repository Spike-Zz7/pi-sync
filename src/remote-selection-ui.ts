import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	defineMenu,
	type MenuActionResult,
	runMenu,
} from "@narumitw/pi-tui-kit";
import {
	type RunRoute,
	type RunRouteResult,
	runCancellableOperation,
} from "./cancellable-operation.js";
import {
	loadConfig,
	loadPartialConfig,
	SyncSetupReviewChangedError,
	syncConfigReviewFingerprint,
	updateSyncSetup,
} from "./config.js";
import {
	createSyncBackend,
	readSnapshotForHead,
	type SyncBackendFactory,
} from "./sync-backend.js";
import {
	continuationCancelledMessage,
	continueBusyLabel,
	continueLabel,
	errorMessage,
	formatLegacySummary,
	formatRemoteSelectionSummary,
	formatSelectionDifference,
	safeTerminalText,
	selectionSummaryLines,
} from "./sync-format.js";
import {
	inspectRemoteSelection,
	type RemoteSelectionDecision,
	type RemoteSelectionState,
	sameSyncInclude,
} from "./sync-policy.js";
import type { AnySyncConfig, PartialConfig } from "./types.js";

const STATUS_KEY = "sync";

export type RemoteSelectionOrigin = "settings" | "sync" | "pull" | "push";

export interface RemoteSelectionReviewOptions {
	decision?: RemoteSelectionDecision;
	origin?: RemoteSelectionOrigin;
	runRoute?: RunRoute;
	cancelLabel?: string;
	onSelectionResolved?: () => void;
	withStateAccess?: <T>(task: () => Promise<T>) => Promise<T>;
}

export type RemoteSelectionReviewResult =
	| { kind: "back" }
	| { kind: "closed" }
	| { kind: "done" }
	| { kind: "stale" }
	| {
			kind: "route-result";
			result: RunRouteResult;
			route: "sync" | "pull" | "push";
	  };

export async function showRemoteSelectionReview(
	ctx: ExtensionContext,
	setupName?: string,
	signal?: AbortSignal,
	factory: SyncBackendFactory = createSyncBackend,
	options: RemoteSelectionReviewOptions = {},
): Promise<RemoteSelectionReviewResult> {
	try {
		const decisionOrResult =
			options.decision ??
			(await resolveInitialDecision(ctx, setupName, signal, factory));
		if ("kind" in decisionOrResult) return decisionOrResult;

		if (ctx.mode !== "tui") {
			ctx.ui.notify(formatRemoteSelectionSummary(decisionOrResult), "warning");
			return { kind: "back" };
		}

		let currentDecision = decisionOrResult;
		for (;;) {
			if (signal?.aborted) return { kind: "stale" };
			const result = await showSelectionDifference(
				ctx,
				currentDecision,
				options.origin ?? "settings",
				options.runRoute,
				signal,
				factory,
				options,
			);
			if (result.kind !== "refresh") return result;
			const refreshed = await runWithOptionalStateAccess(options, () =>
				inspectConfiguredRemoteSelection(
					ctx,
					currentDecision.setupName,
					signal,
					factory,
				),
			);
			if (!refreshed || signal?.aborted) return { kind: "stale" };
			if (refreshed.kind === "empty") {
				ctx.ui.notify(
					"Remote storage no longer has a snapshot or synced-content list.",
					"warning",
				);
				return { kind: "back" };
			}
			if (refreshed.state.kind !== "different") {
				ctx.ui.notify(
					refreshed.state.kind === "same"
						? "Remote synced content now matches this sync setup."
						: "The refreshed legacy snapshot has no authoritative synced-content list.",
					"info",
				);
				options.onSelectionResolved?.();
				return { kind: "done" };
			}
			currentDecision = decisionFromState(refreshed.config, refreshed.state);
		}
	} catch (error) {
		if (signal?.aborted) return { kind: "stale" };
		ctx.ui.notify(
			`Could not review synced content: ${errorMessage(error)}`,
			"error",
		);
		return { kind: "back" };
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function resolveInitialDecision(
	ctx: ExtensionContext,
	setupName: string | undefined,
	signal: AbortSignal | undefined,
	factory: SyncBackendFactory,
): Promise<RemoteSelectionDecision | RemoteSelectionReviewResult> {
	const inspected = await inspectConfiguredRemoteSelection(
		ctx,
		setupName,
		signal,
		factory,
	);
	if (!inspected || signal?.aborted) return { kind: "stale" };
	if (inspected.kind === "empty") {
		ctx.ui.notify(
			"Remote storage has no snapshot or synced-content list yet.",
			"info",
		);
		return { kind: "back" };
	}
	if (inspected.state.kind === "same") {
		ctx.ui.notify(
			"Remote synced content already matches this sync setup.",
			"info",
		);
		return { kind: "back" };
	}
	if (inspected.state.kind === "legacy") {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				formatLegacySummary(inspected.config, inspected.state.discovered),
				"info",
			);
		} else {
			await showLegacyDiscovery(
				ctx,
				inspected.config,
				inspected.state.discovered,
				signal,
			);
		}
		return signal?.aborted ? { kind: "stale" } : { kind: "back" };
	}
	return decisionFromState(inspected.config, inspected.state);
}

type DifferenceFlowResult = RemoteSelectionReviewResult | { kind: "refresh" };

const item = <A extends string>(
	id: A,
	label: string,
	description?: string,
) => ({ id, label, ...(description ? { description } : {}), action: id });

const choiceItems = (cancelLabel = "Cancel") => [
	{
		id: "review" as const,
		label: "Review all paths (recommended)",
		description: "Compare exact remote-only, device-only, and ordered lists.",
		to: "review" as const,
	},
	item(
		"adopt" as const,
		"Use remote content list",
		"Save the reviewed list on this device without pulling files.",
	),
	item(
		"keep" as const,
		"Keep this device's content list and update remote…",
		"Open the existing exact force-push preview without skipping confirmation.",
	),
	item("cancel" as const, cancelLabel),
];

const savedItems = (
	runRoute?: RunRoute,
	origin: RemoteSelectionOrigin = "settings",
) => [
	...(runRoute
		? [
				item(
					"continue" as const,
					continueLabel(origin),
					"Start a fresh check and exact preview for this sync setup.",
				),
			]
		: []),
	item("done" as const, "Done"),
];

async function confirmSessionInclude(
	ctx: ExtensionContext,
	current: readonly string[],
	remote: readonly string[],
	signal: AbortSignal,
) {
	if (current.includes("sessions") || !remote.includes("sessions")) return true;
	return ctx.ui.confirm(
		"Use a content list that includes session conversations?",
		"Session JSONL may contain prompts, tool output, file paths, images, and secrets. This saves the list only; it does not pull files.",
		{ signal },
	);
}

async function showSelectionDifference(
	ctx: ExtensionContext,
	initialDecision: RemoteSelectionDecision,
	origin: RemoteSelectionOrigin,
	runRoute: RunRoute | undefined,
	sessionSignal: AbortSignal | undefined,
	factory: SyncBackendFactory,
	options: Pick<
		RemoteSelectionReviewOptions,
		"cancelLabel" | "onSelectionResolved" | "withStateAccess"
	>,
): Promise<DifferenceFlowResult> {
	type Screen = "choice" | "review" | "saved";
	type Action = "adopt" | "keep" | "cancel" | "continue" | "done";
	interface FlowState {
		decision: RemoteSelectionDecision;
		saved: boolean;
	}
	let flowState: FlowState = { decision: initialDecision, saved: false };
	let continuationReview: PartialConfig | undefined;
	let nextResult: RemoteSelectionReviewResult | undefined;
	let refreshRequested = false;
	const route = origin === "settings" ? "sync" : origin;

	function handleActionError(error: unknown, failurePrefix: string) {
		if (isStaleReviewError(error)) {
			ctx.ui.notify(
				`${errorMessage(error)} Refreshing the comparison.`,
				"warning",
			);
			refreshRequested = true;
			return { kind: "close" as const };
		}
		ctx.ui.notify(`${failurePrefix}: ${errorMessage(error)}`, "error");
		return { kind: "stay" as const };
	}

	async function runRouteAction(
		actionSignal: AbortSignal,
		busyText: string,
		opRoute: "sync" | "pull" | "push" | "push --force",
		nestedRoute: "sync" | "pull" | "push",
		cancelledMessage: string,
		target: string,
	): Promise<MenuActionResult<Screen>> {
		if (!runRoute) {
			ctx.ui.notify(
				nestedRoute === "push"
					? "The reviewed update-remote route is unavailable."
					: "The route is unavailable.",
				"error",
			);
			return { kind: "stay" as const };
		}
		const result = await runCancellableOperation(
			ctx,
			busyText,
			opRoute,
			runRoute,
			{ commitAware: true, cancelledMessage, target, signal: actionSignal },
		);
		if (result.kind === "completed" && result.outcome === "applied") {
			options.onSelectionResolved?.();
		}
		if (result.kind === "closed") {
			nextResult = { kind: "closed" };
			return { kind: "close" as const };
		}
		if (
			result.kind === "cancelled" ||
			(result.kind === "completed" && result.outcome === "cancelled") ||
			result.kind === "failed"
		) {
			return { kind: "stay" as const };
		}
		nextResult = { kind: "route-result", result, route: nestedRoute };
		return { kind: "close" as const };
	}

	async function runAction(
		actionSignal: AbortSignal,
		failurePrefix: string,
		handler: (
			signal: AbortSignal,
		) => Promise<MenuActionResult<Screen> | undefined>,
	) {
		const signal = combineSignals(sessionSignal, actionSignal);
		try {
			return (await handler(signal)) ?? { kind: "stay" as const };
		} catch (error) {
			if (signal.aborted) return { kind: "close" as const };
			return handleActionError(error, failurePrefix);
		}
	}

	async function loadAndAssertCurrentConfig(
		decision: RemoteSelectionDecision,
		signal: AbortSignal,
	) {
		const config = await loadConfig(decision.setupName);
		if (signal.aborted) return undefined;
		assertLocalSelectionCurrent(config, decision);
		return config;
	}

	const menu = defineMenu<FlowState, Screen, Action, ExtensionContext>({
		start: "choice",
		screens: {
			choice: ({ state }) => ({
				kind: "actions",
				title: "Synced content differs",
				lines: selectionSummaryLines(state.decision),
				items: choiceItems(options.cancelLabel),
				hint: "back",
			}),
			review: ({ state }) => ({
				kind: "review",
				title: `Review synced content · ${safeTerminalText(state.decision.setupName)}`,
				content: formatSelectionDifference(state.decision),
				format: { kind: "text" },
				viewportSize: "adaptive",
				hint: "back",
			}),
			saved: ({ state }) => ({
				kind: "actions",
				title: "Remote content list saved",
				lines: [
					`Sync setup: ${safeTerminalText(state.decision.setupName)}`,
					"Only the included-content setting was saved.",
					"No files were pulled and sync state was not changed.",
				],
				items: savedItems(runRoute, origin),
				hint: "close",
			}),
		},
		actions: {
			adopt: ({ state, signal }) =>
				runAction(
					signal,
					"Could not save the remote content list",
					async (s) => {
						const currentConfig = await loadAndAssertCurrentConfig(
							state.decision,
							s,
						);
						if (!currentConfig) return { kind: "close" };
						const confirmed = await confirmSessionInclude(
							ctx,
							currentConfig.include,
							state.decision.remoteInclude,
							s,
						);
						if (s.aborted) return { kind: "close" };
						if (!confirmed) return { kind: "stay" };
						const storageReview = await runWithOptionalStateAccess(
							options,
							() =>
								adoptRemoteSelection(state.decision, currentConfig, s, factory),
						);
						if (s.aborted) return { kind: "close" };
						options.onSelectionResolved?.();
						continuationReview = {
							...storageReview,
							setupName: state.decision.setupName,
							include: [...state.decision.remoteInclude],
							automatic: currentConfig.automatic,
							onSwitch: currentConfig.onSwitch,
						};
						flowState = { decision: state.decision, saved: true };
						return { kind: "to", screen: "saved" };
					},
				),
			keep: ({ state, signal }) =>
				runAction(signal, "Could not prepare the remote update", async (s) => {
					const latest = await loadAndAssertCurrentConfig(state.decision, s);
					if (!latest) return { kind: "close" };
					return runRouteAction(
						s,
						"Preparing this device's push preview…",
						"push --force",
						"push",
						"Push preparation cancelled; no remote files were changed.",
						state.decision.setupName,
					);
				}),
			continue: ({ state, signal }) =>
				runAction(signal, "Could not continue", async (s) => {
					if (!continuationReview) return { kind: "stay" };
					const latest = await loadPartialConfig(state.decision.setupName);
					if (s.aborted) return { kind: "close" };
					if (!sameContinuationReview(latest, continuationReview)) {
						throw new StaleRemoteSelectionReviewError(
							`Sync setup “${safeTerminalText(state.decision.setupName)}” changed after the remote content list was saved.`,
						);
					}
					return runRouteAction(
						s,
						continueBusyLabel(origin),
						route,
						route,
						continuationCancelledMessage(route),
						state.decision.setupName,
					);
				}),
			cancel: async () => ({ kind: "back" }),
			done: async () => {
				nextResult = { kind: "done" };
				return { kind: "close" };
			},
		},
	});

	const menuResult = await runMenu(ctx, menu, {
		getState: () => flowState,
		signal: sessionSignal,
		isCurrent: () => !sessionSignal?.aborted,
		onError: (_menuCtx, error) => ctx.ui.notify(errorMessage(error), "error"),
	});
	if (sessionSignal?.aborted || menuResult.kind === "stale")
		return { kind: "stale" };
	if (refreshRequested) return { kind: "refresh" };
	if (nextResult) return nextResult;
	return menuResult.kind === "closed" && menuResult.reason === "back"
		? { kind: "back" }
		: { kind: "closed" };
}

async function adoptRemoteSelection(
	decision: RemoteSelectionDecision,
	config: AnySyncConfig,
	signal: AbortSignal,
	factory: SyncBackendFactory,
) {
	const storageReview = await loadPartialConfig(decision.setupName);
	throwIfAborted(signal);
	if (!sameSyncInclude(storageReview.include, decision.localInclude)) {
		throw new StaleRemoteSelectionReviewError(
			`Sync setup “${safeTerminalText(decision.setupName)}” changed while the comparison was open.`,
		);
	}
	const backend = await factory(config);
	throwIfAborted(signal);
	const head = await backend.readHead(signal);
	throwIfAborted(signal);
	if (!head) {
		throw new StaleRemoteSelectionReviewError(
			"Remote storage changed while the comparison was open.",
		);
	}
	const snapshot = await readSnapshotForHead(backend, head, signal);
	throwIfAborted(signal);
	const state = inspectRemoteSelection(config.include, snapshot);
	if (
		state.kind !== "different" ||
		!sameSyncInclude(state.include, decision.remoteInclude)
	) {
		throw new StaleRemoteSelectionReviewError(
			"Remote synced content changed while the comparison was open.",
		);
	}
	await updateSyncSetup(
		decision.setupName,
		(setup) => ({
			...setup,
			sync: { ...setup.sync, include: [...decision.remoteInclude] },
		}),
		{
			expectedStorage: storageReview,
			expectedInclude: decision.localInclude,
			signal,
		},
	);
	return storageReview;
}

async function inspectConfiguredRemoteSelection(
	ctx: ExtensionContext,
	setupName: string | undefined,
	signal: AbortSignal | undefined,
	factory: SyncBackendFactory,
): Promise<
	| { kind: "empty"; config: AnySyncConfig }
	| { kind: "selection"; config: AnySyncConfig; state: RemoteSelectionState }
	| undefined
> {
	const config = await loadConfig(setupName);
	if (signal?.aborted) return undefined;
	ctx.ui.setStatus(
		STATUS_KEY,
		`checking synced content for ${safeTerminalText(config.setupName)}`,
	);
	const backend = await factory(config);
	if (signal?.aborted) return undefined;
	const head = await backend.readHead(signal);
	if (signal?.aborted || !head)
		return head ? undefined : { kind: "empty", config };
	const snapshot = await readSnapshotForHead(backend, head, signal);
	if (signal?.aborted) return undefined;
	return {
		kind: "selection",
		config,
		state: inspectRemoteSelection(config.include, snapshot),
	};
}

async function showLegacyDiscovery(
	ctx: ExtensionContext,
	config: AnySyncConfig,
	discovered: string[],
	signal?: AbortSignal,
) {
	const discoveredLines =
		discovered.length > 0
			? discovered.map((item) => `Discovered: ${safeTerminalText(item)}`)
			: ["No safe paths were discovered."];
	const content = [
		"Partial discovery only — not an authoritative selection.",
		"",
		...discoveredLines,
		"",
		"Use Add custom path… in the local Included Content editor if needed.",
	].join("\n");
	return runMenu(
		ctx,
		defineMenu<undefined, "choice" | "review", "back", ExtensionContext>({
			start: "choice",
			screens: {
				choice: () => ({
					kind: "actions",
					title: `Compare synced content · ${safeTerminalText(config.setupName)}`,
					lines: [
						"This legacy snapshot has no portable synced-content list.",
						"Discovered paths are partial and read-only; preserved files may not have been selected.",
					],
					items: [
						{ id: "review", label: "Review discovered paths", to: "review" },
						{ id: "back", label: "Back", action: "back" },
					],
					hint: "close",
				}),
				review: () => ({
					kind: "review",
					title: "Partial discovery from legacy snapshot",
					content,
					format: { kind: "text" },
					viewportSize: "adaptive",
					hint: "back",
				}),
			},
			actions: { back: async () => ({ kind: "close" }) },
		}),
		{ getState: () => undefined, signal, isCurrent: () => !signal?.aborted },
	);
}

function decisionFromState(
	config: AnySyncConfig,
	state: Extract<RemoteSelectionState, { kind: "different" }>,
): RemoteSelectionDecision {
	return {
		setupName: config.setupName,
		configIdentity: syncConfigReviewFingerprint(config),
		localInclude: [...config.include],
		remoteInclude: [...state.include],
	};
}

function assertLocalSelectionCurrent(
	config: AnySyncConfig,
	decision: RemoteSelectionDecision,
) {
	if (
		syncConfigReviewFingerprint(config) !== decision.configIdentity ||
		!sameSyncInclude(config.include, decision.localInclude)
	) {
		throw new StaleRemoteSelectionReviewError(
			`Sync setup “${safeTerminalText(config.setupName)}” changed while the comparison was open.`,
		);
	}
}

function sameContinuationReview(left: PartialConfig, right: PartialConfig) {
	return (
		left.setupName === right.setupName &&
		left.connectionName === right.connectionName &&
		left.storageKind === right.storageKind &&
		left.storagePath === right.storagePath &&
		left.branch === right.branch &&
		sameSyncInclude(left.include, right.include)
	);
}

class StaleRemoteSelectionReviewError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StaleRemoteSelectionReviewError";
	}
}

function isStaleReviewError(error: unknown) {
	return (
		error instanceof StaleRemoteSelectionReviewError ||
		error instanceof SyncSetupReviewChangedError
	);
}

function runWithOptionalStateAccess<T>(
	options: Pick<RemoteSelectionReviewOptions, "withStateAccess">,
	task: () => Promise<T>,
) {
	return options.withStateAccess ? options.withStateAccess(task) : task();
}

function combineSignals(
	sessionSignal: AbortSignal | undefined,
	actionSignal: AbortSignal,
) {
	return sessionSignal
		? AbortSignal.any([sessionSignal, actionSignal])
		: actionSignal;
}

function throwIfAborted(signal: AbortSignal) {
	if (signal.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new DOMException("The operation was aborted", "AbortError");
	}
}
