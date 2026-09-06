import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type ActionMenuItem, defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
	type RunRoute,
	runCancellableOperation,
} from "./cancellable-operation.js";
import { setSyncSetupCompletions } from "./command.js";
import {
	configuredSyncSetupNames,
	loadConfig,
	loadOnSwitch,
	loadPartialConfig,
	localConfigPath,
	readLocalConfigObject,
	removeSyncSetup,
	syncConfigReviewIdentity,
} from "./config.js";
import {
	promptInitialSetupName,
	safeGitRemote,
	showAddGitTarget,
	showAddStorageConnection,
	showEditGitTarget,
	showGitSetup,
	showStorageConnections,
} from "./git-ui.js";
import {
	errorMessage,
	ownRecord,
	requiredInput,
	safeTerminalText,
} from "./manager-helpers.js";
import { dispatchManagerResult } from "./manager-result-dispatcher.js";
import {
	backendStorageDescription,
	describeManagerState,
	operationCanRecover,
	recoverSyncAccess,
} from "./manager-state.js";
import { showSyncSettings } from "./settings-ui.js";
import { useSyncSetup } from "./setup-switch.js";

import {
	attentionMainMenuItems,
	blockedSyncMenuItem,
	type SyncManagerAttentionOptions,
	showManagerAttention,
} from "./sync-attention.js";
import {
	summarizeIncludedContent,
	syncIncludeSelection,
} from "./sync-policy.js";
import type { AnySyncConfig } from "./types.js";

export async function showSyncManager(
	ctx: ExtensionCommandContext,
	runRoute: RunRoute,
	sessionSignal?: AbortSignal,
	options: SyncManagerAttentionOptions = {},
): Promise<void> {
	if (!ctx.hasUI) {
		await runRoute("help");
		return;
	}
	type Screen = "main" | "more" | "recovery";
	type Action =
		| "review-attention"
		| "sync"
		| "switch"
		| "diff"
		| "settings"
		| "pull"
		| "push"
		| "files"
		| "setups"
		| "connections"
		| "history"
		| "doctor"
		| "unlock"
		| "recover"
		| "refresh"
		| "help"
		| "init"
		| "back";
	interface State {
		manager: Awaited<ReturnType<typeof describeManagerState>>;
	}
	const menu = defineMenu<State, Screen, Action, ExtensionCommandContext>({
		start: "main",
		screens: {
			main: ({ state }) => {
				const attentionItems = attentionMainMenuItems(state.manager);
				const managerItems = state.manager.actions.map(
					(label) =>
						blockedSyncMenuItem(label, state.manager) ??
						syncMainMenuItem(label),
				);
				const operationFirst =
					state.manager.operation !== undefined &&
					state.manager.operation.kind !== "free";
				return {
					kind: "actions",
					title: "Manage sync",
					lines: state.manager.title.split("\n").slice(1),
					items: operationFirst
						? [...managerItems, ...attentionItems]
						: [...attentionItems, ...managerItems],
					hint: "close",
				};
			},
			more: () => ({
				kind: "actions",
				title: "More options",
				items: [
					{ id: "pull", label: "Pull from remote…", action: "pull" },
					{ id: "push", label: "Push to remote…", action: "push" },
					{ id: "files", label: "Included content…", action: "files" },
					{ id: "setups", label: "Sync setups…", action: "setups" },
					{
						id: "connections",
						label: "Storage connections…",
						action: "connections",
					},
					{ id: "recovery", label: "History & recovery…", to: "recovery" },
					{ id: "help", label: "Help", action: "help" },
					{ id: "back", label: "Back", action: "back" },
				],
				hint: "back",
			}),
			recovery: ({ state }) => ({
				kind: "actions",
				title: "History & recovery",
				items: [
					{ id: "history", label: "Browse history", action: "history" },
					{ id: "doctor", label: "Check setup", action: "doctor" },
					...(state.manager.operation &&
					operationCanRecover(state.manager.operation)
						? [
								{
									id: "unlock",
									label: "Recover stale operation",
									action: "unlock" as const,
								},
							]
						: []),
					{ id: "back", label: "Back", action: "back" },
				],
				hint: "back",
			}),
		},
		actions: {
			"review-attention": async () => {
				const attention = options.getAttention?.();
				if (!attention) return { kind: "stay" };
				const disposition = await showManagerAttention(
					ctx,
					attention,
					runRoute,
					sessionSignal,
					() => options.onSelectionResolved?.(attention),
				);
				return { kind: disposition };
			},
			sync: async () => {
				const pendingAttention = options.getAttention?.();
				if (pendingAttention) {
					const activeConfig = await loadConfig();
					if (sessionSignal?.aborted) return { kind: "close" };
					if (pendingAttention.decision.setupName === activeConfig.setupName) {
						ctx.ui.notify(
							"Review synced content before starting Sync now.",
							"warning",
						);
						return { kind: "stay" };
					}
				}
				const result = await runCancellableOperation(
					ctx,
					"Checking current sync setup…",
					"sync",
					runRoute,
					{
						commitAware: true,
						signal: sessionSignal,
					},
				);
				const disposition = await dispatchManagerResult(
					ctx,
					result,
					"sync",
					runRoute,
					sessionSignal,
				);
				return disposition.kind === "close"
					? { kind: "close" }
					: { kind: "stay" };
			},
			switch: async () => {
				const result = await showSetupSwitcher(
					ctx,
					runRoute,
					undefined,
					sessionSignal,
				);
				return result === "pull-attempted" || result === "closed"
					? { kind: "close" }
					: { kind: "stay" };
			},
			diff: async () => {
				const result = await runCancellableOperation(
					ctx,
					"Checking current sync setup…",
					"diff",
					runRoute,
					{ signal: sessionSignal },
				);
				return result.kind === "closed" ? { kind: "close" } : { kind: "stay" };
			},
			settings: async () => {
				await showSyncSettings(ctx, runRoute, sessionSignal);
				return { kind: "stay" };
			},
			pull: async () => {
				const result = await runCancellableOperation(
					ctx,
					"Checking remote changes…",
					"pull",
					runRoute,
					{
						commitAware: true,
						cancelledMessage:
							"Pull check cancelled; no local files were changed.",
						signal: sessionSignal,
					},
				);
				const disposition = await dispatchManagerResult(
					ctx,
					result,
					"pull",
					runRoute,
					sessionSignal,
				);
				return disposition.kind === "close"
					? { kind: "close" }
					: { kind: "stay" };
			},
			push: async () => {
				const result = await runCancellableOperation(
					ctx,
					"Preparing push preview…",
					"push",
					runRoute,
					{
						commitAware: true,
						cancelledMessage:
							"Push preparation cancelled; no remote files were changed.",
						signal: sessionSignal,
					},
				);
				const disposition = await dispatchManagerResult(
					ctx,
					result,
					"push",
					runRoute,
					sessionSignal,
				);
				return disposition.kind === "close"
					? { kind: "close" }
					: { kind: "stay" };
			},
			files: async () => {
				const { showFileSelection } = await import("./file-selection.js");
				await showFileSelection(ctx, undefined, sessionSignal);
				return { kind: "stay" };
			},
			setups: async () => {
				const result = await showSyncSetupManager(ctx, runRoute, sessionSignal);
				return result === "exit" ? { kind: "close" } : { kind: "stay" };
			},
			connections: async () => {
				await showStorageConnections(ctx, sessionSignal);
				return { kind: "stay" };
			},
			history: async () => {
				await runRoute("history");
				return { kind: "stay" };
			},
			doctor: async () => {
				await runRoute("doctor");
				return { kind: "stay" };
			},
			unlock: async ({ state, signal: actionSignal }) => {
				const result = await recoverSyncAccess(
					ctx,
					state.manager,
					runRoute,
					sessionSignal,
					actionSignal,
				);
				if (result === "close") return { kind: "close" };
				return result === "restored"
					? { kind: "to", screen: "main" }
					: { kind: "stay" };
			},
			recover: async ({ state, signal: actionSignal }) => {
				const result = await recoverSyncAccess(
					ctx,
					state.manager,
					runRoute,
					sessionSignal,
					actionSignal,
				);
				return { kind: result === "close" ? "close" : "stay" };
			},
			refresh: async () => ({ kind: "stay" }),
			help: async () => {
				await runRoute("help");
				return { kind: "close" };
			},
			init: async () => {
				await runRoute("init");
				return { kind: "stay" };
			},
			back: async () => ({ kind: "back" }),
		},
	});
	await runMenu(ctx, menu, {
		getState: async () => {
			const pendingAttention = options.getAttention?.();
			const manager = await describeManagerState(
				sessionSignal,
				pendingAttention,
			);
			if (
				pendingAttention &&
				options.getAttention?.() === pendingAttention &&
				!manager.attention
			) {
				options.onSelectionResolved?.(pendingAttention);
			}
			return { manager };
		},
		signal: sessionSignal,
		isCurrent: () => !sessionSignal?.aborted,
	});
}

function syncMainMenuItem(
	label: string,
): ActionMenuItem<
	"main" | "more" | "recovery",
	| "sync"
	| "switch"
	| "diff"
	| "settings"
	| "setups"
	| "connections"
	| "recover"
	| "refresh"
	| "help"
	| "init"
> {
	if (label === "More…") return { id: "more", label, to: "more" };
	if (label === "History & recovery…")
		return { id: "recovery", label, to: "recovery" };
	const actions = new Map<
		string,
		| "sync"
		| "switch"
		| "diff"
		| "settings"
		| "setups"
		| "connections"
		| "recover"
		| "refresh"
		| "help"
		| "init"
	>([
		["Sync now (recommended)", "sync"],
		["Switch sync setup", "switch"],
		["Status & changes", "diff"],
		["Settings", "settings"],
		["Restore sync access… (recommended)", "recover"],
		["Refresh operation status", "refresh"],
		["Sync setups…", "setups"],
		["Storage connections…", "connections"],
		["Help", "help"],
		["Set up sync", "init"],
		["Use existing settings", "init"],
	]);
	return {
		id: actions.get(label) ?? "help",
		label,
		action: actions.get(label) ?? "help",
	};
}

export async function showSetupWizard(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			`Guided sync setup requires TUI mode for safe credential input. Create version 3 settings in ${safeTerminalText(localConfigPath())}.`,
			"warning",
		);
		return false;
	}
	const targetName = await promptInitialSetupName(ctx, signal);
	if (!targetName) return false;
	const saved = await showGitSetup(ctx, targetName, signal);
	if (signal?.aborted) return false;
	if (saved) await refreshTargetCompletions();
	return saved;
}

async function selectSetupForSwitch(
	ctx: ExtensionCommandContext,
	raw: Record<string, unknown>,
	targets: Record<string, unknown>,
	active: string | undefined,
	signal?: AbortSignal,
) {
	let selectedName: string | undefined;
	const nameById = new Map<string, string>();
	const profiles = ownRecord(raw.storageConnections);
	const menu = defineMenu<
		undefined,
		"setups",
		"select",
		ExtensionCommandContext
	>({
		start: "setups",
		screens: {
			setups: () => ({
				kind: "actions",
				title: "Switch sync setup",
				lines: [`Current sync setup: ${safeTerminalText(active ?? "none")}`],
				items: Object.keys(targets)
					.sort((left, right) => left.localeCompare(right))
					.map((candidate, index) => {
						const target = ownRecord(targets[candidate]);
						const storage = ownRecord(target?.storage);
						const profileName =
							typeof storage?.connection === "string"
								? storage.connection
								: undefined;
						const profile =
							profileName && profiles
								? ownRecord(profiles[profileName])
								: undefined;
						const location = profile
							? `${String(storage?.branch ?? "missing branch")}:${String(storage?.path ?? "missing path")}`
							: `invalid: missing connection ${profileName ?? "reference"}`;
						const id = `setup:${index}`;
						nameById.set(id, candidate);
						return {
							id,
							label: `${safeTerminalText(candidate)}${candidate === active ? " (current)" : ""}`,
							description: `${safeTerminalText(profileName ?? "unknown")} · ${safeTerminalText(location)}`,
							action: "select" as const,
						};
					}),
				hint: "close",
			}),
		},
		actions: {
			select: async ({ itemId }) => {
				selectedName = nameById.get(itemId);
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal,
		isCurrent: () => !signal?.aborted,
	});
	return selectedName;
}

async function showSetupSwitcher(
	ctx: ExtensionCommandContext,
	runRoute: RunRoute,
	selectedName?: string,
	signal?: AbortSignal,
) {
	const raw = await readLocalConfigObject();
	if (signal?.aborted) return false;
	if (raw?.version !== 3) {
		ctx.ui.notify("Add a second sync setup before switching setups.", "info");
		return false;
	}
	const targets = ownRecord(raw.syncSetups);
	if (!targets) {
		ctx.ui.notify("No sync setups are configured.", "warning");
		return false;
	}
	const active =
		typeof raw.activeSyncSetup === "string" ? raw.activeSyncSetup : undefined;
	let name = selectedName;
	if (!name) {
		name = await selectSetupForSwitch(ctx, raw, targets, active, signal);
		if (!name) return false;
	}
	if (!name || !Object.hasOwn(targets, name)) {
		ctx.ui.notify(
			`Sync setup “${safeTerminalText(name ?? "unknown")}” no longer exists.`,
			"warning",
		);
		return false;
	}
	if (name === active) {
		ctx.ui.notify(
			`Sync setup “${safeTerminalText(name)}” is already current.`,
			"info",
		);
		return false;
	}
	let config: AnySyncConfig;
	try {
		config = await loadConfig(name);
		if (signal?.aborted) return false;
	} catch (error) {
		ctx.ui.notify(
			`Cannot use sync setup “${safeTerminalText(name)}”: ${safeTerminalText(errorMessage(error))}`,
			"error",
		);
		return false;
	}
	const onSwitch = await loadOnSwitch();
	if (signal?.aborted) return false;
	const switchEffect =
		onSwitch === "ask-before-pull"
			? "After switching, pi-sync will ask whether to review a pull for this setup."
			: onSwitch === "pull-after-switch"
				? "After switching, pi-sync will check this setup and show exact changes before applying them."
				: "After switching, pi-sync will not pull or modify synced files.";
	const confirmed = await ctx.ui.confirm(
		"Switch sync setup?",
		[
			`From: ${safeTerminalText(active ?? "none")}`,
			`To: ${safeTerminalText(name)}`,
			`Storage: ${backendStorageDescription(config)}`,
			`Included content: ${config.include.length} paths`,
			`Automatic sync: ${config.automatic ? "On" : "Off"} · Sessions: ${config.include.includes("sessions") ? "On" : "Off"}`,
			"",
			switchEffect,
		].join("\n"),
		{ signal },
	);
	if (signal?.aborted || !confirmed) return false;
	let pullStarted = false;
	try {
		let pullClosed = false;
		const result = await useSyncSetup(
			ctx,
			name,
			async (selectedTarget) => {
				pullStarted = true;
				const pullResult = await runCancellableOperation(
					ctx,
					`Pulling sync setup “${safeTerminalText(name)}”…`,
					"pull",
					runRoute,
					{
						commitAware: true,
						cancelledMessage: null,
						target: selectedTarget,
						signal,
					},
				);
				const disposition = await dispatchManagerResult(
					ctx,
					pullResult,
					"pull",
					runRoute,
					signal,
				);
				if (
					pullResult.kind === "closed" ||
					pullResult.kind.endsWith("required")
				) {
					pullClosed = disposition.kind === "close";
				}
				if (disposition.appliedRoute === "pull") return "applied";
				if (pullResult.kind === "completed") return pullResult.outcome;
				return pullResult.kind === "cancelled" ? "cancelled" : undefined;
			},
			onSwitch,
			signal,
			syncConfigReviewIdentity(config),
		);
		if (pullClosed) return "closed";
		return result.pullApplied ? "pull-attempted" : "switched";
	} catch (error) {
		if (signal?.aborted) return false;
		ctx.ui.notify(
			pullStarted
				? `Switched to “${safeTerminalText(name)}”, but pull failed: ${safeTerminalText(errorMessage(error))}`
				: `Sync setup “${safeTerminalText(name)}” was not switched: ${safeTerminalText(errorMessage(error))}`,
			"error",
		);
		return false;
	}
}

async function showSyncSetupManager(
	ctx: ExtensionCommandContext,
	runRoute: RunRoute,
	signal?: AbortSignal,
) {
	return showSyncSetups(
		ctx,
		{
			add: async (setupSignal) => {
				await showAddTarget(ctx, setupSignal);
			},
			edit: async (name, setupSignal) => {
				await showEditTarget(ctx, name, setupSignal);
			},
			makeCurrent: async (name, setupSignal) => {
				const result = await showSetupSwitcher(
					ctx,
					runRoute,
					name,
					setupSignal,
				);
				return result === "pull-attempted" || result === "closed"
					? "exit"
					: undefined;
			},
			remove: async (name, setupSignal) => {
				await showRemoveTarget(ctx, name, setupSignal);
			},
		},
		signal,
	);
}

async function showAddTarget(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
) {
	let raw = await readLocalConfigObject();
	if (signal?.aborted) return;
	if (!raw)
		return void ctx.ui.notify(
			"Set up the first sync setup before adding another.",
			"info",
		);
	if (raw.version !== 3) {
		ctx.ui.notify(
			"Version 1 and version 2 settings are unsupported and are never migrated.",
			"error",
		);
		return;
	}
	let profiles = ownRecord(raw.storageConnections) ?? {};
	const name = await requiredInput(
		ctx,
		"Name the new sync setup",
		"work",
		signal,
	);
	if (!name) return;
	const createConnection = "Add a new storage connection…";
	let profile = await ctx.ui.select(
		"Choose a storage connection",
		[...Object.keys(profiles).sort(), createConnection, "Cancel"],
		{ signal },
	);
	if (!profile || profile === "Cancel") return;
	if (profile === createConnection) {
		const previousNames = new Set(Object.keys(profiles));
		if (!(await showAddStorageConnection(ctx, signal))) return;
		if (signal?.aborted) return;
		raw = (await readLocalConfigObject()) ?? raw;
		if (signal?.aborted) return;
		profiles = ownRecord(raw.storageConnections) ?? {};
		profile = Object.keys(profiles).find(
			(candidate) => !previousNames.has(candidate),
		);
		if (!profile) return;
	}
	const saved = await showAddGitTarget(ctx, name, profile, signal);
	if (signal?.aborted) return;
	if (saved) await refreshTargetCompletions();
}

async function showEditTarget(
	ctx: ExtensionCommandContext,
	name: string,
	signal?: AbortSignal,
) {
	const partial = await loadPartialConfig(name);
	if (signal?.aborted) return;
	if (!partial.setupName) {
		ctx.ui.notify(
			"Create version 3 settings before editing a named sync setup.",
			"info",
		);
		return;
	}
	await showEditGitTarget(ctx, partial, signal);
}

async function showRemoveTarget(
	ctx: ExtensionCommandContext,
	name: string,
	signal?: AbortSignal,
) {
	const confirmed = await ctx.ui.confirm(
		"Remove sync setup?",
		`Remove local sync setup “${safeTerminalText(name)}”? Remote data and history are not deleted.`,
		{ signal },
	);
	if (signal?.aborted || !confirmed) return;
	await removeSyncSetup(name, signal);
	if (signal?.aborted) return;
	await refreshTargetCompletions();
	ctx.ui.notify(
		`Removed sync setup “${safeTerminalText(name)}”; remote data was not deleted.`,
		"info",
	);
}

async function refreshTargetCompletions() {
	setSyncSetupCompletions(await configuredSyncSetupNames());
}

export type SyncSetupActions = {
	add(signal?: AbortSignal): Promise<void>;
	edit(name: string, signal?: AbortSignal): Promise<void>;
	makeCurrent(name: string, signal?: AbortSignal): Promise<"exit" | undefined>;
	remove(name: string, signal?: AbortSignal): Promise<void>;
};

interface SetupMenuState {
	setups: Record<string, unknown>;
	active?: string;
	selected?: {
		name: string;
		detail: string[];
		valid: boolean;
		removeUnavailable: boolean;
	};
}

export async function showSyncSetups(
	ctx: ExtensionCommandContext,
	actions: SyncSetupActions,
	signal?: AbortSignal,
): Promise<"exit" | undefined> {
	let selectedName: string | undefined;
	let exit = false;
	const nameById = new Map<string, string>();
	type Screen = "list" | "detail";
	type Action =
		| "add"
		| "select"
		| "make-current"
		| "files"
		| "edit"
		| "remove"
		| "back";
	const menu = defineMenu<
		SetupMenuState,
		Screen,
		Action,
		ExtensionCommandContext
	>({
		start: "list",
		screens: {
			list: ({ state }) => {
				nameById.clear();
				const names = Object.keys(state.setups).sort((left, right) =>
					left.localeCompare(right),
				);
				return {
					kind: "actions",
					title: "Sync setups",
					items: [
						{ id: "add", label: "Add sync setup", action: "add" },
						...names.map((name, index) => {
							const id = `setup:${index}`;
							nameById.set(id, name);
							return {
								id,
								label: `${safeTerminalText(name)}${name === state.active ? " (current)" : ""}`,
								action: "select" as const,
							};
						}),
					],
					hint: "back",
				};
			},
			detail: ({ state }) => ({
				kind: "actions",
				title: state.selected
					? `Sync setup “${safeTerminalText(state.selected.name)}”`
					: "Sync setup",
				lines: state.selected?.detail ?? ["This sync setup no longer exists."],
				items: state.selected
					? [
							...(!state.selected.name ||
							state.selected.name === state.active ||
							!state.selected.valid
								? []
								: [
										{
											id: "make-current",
											label: "Make current…",
											action: "make-current" as const,
										},
									]),
							...(state.selected.valid
								? [
										{
											id: "files",
											label: "Included content…",
											action: "files" as const,
										},
									]
								: []),
							{ id: "edit", label: "Edit sync setup…", action: "edit" },
							...(state.selected.removeUnavailable
								? []
								: [
										{
											id: "remove",
											label: "Remove sync setup…",
											action: "remove" as const,
										},
									]),
							{ id: "back", label: "Back", action: "back" },
						]
					: [{ id: "back", label: "Back", action: "back" }],
				hint: "back",
			}),
		},
		actions: {
			add: async () => {
				try {
					await actions.add(signal);
				} catch (error) {
					if (!signal?.aborted) {
						ctx.ui.notify(
							`Sync setup was not added: ${safeTerminalText(errorMessage(error))} Retry from Add sync setup.`,
							"error",
						);
					}
				}
				return { kind: "stay" };
			},
			select: async ({ itemId }) => {
				selectedName = nameById.get(itemId);
				return selectedName
					? { kind: "to", screen: "detail" }
					: { kind: "rejected" };
			},
			"make-current": async () => {
				if (!selectedName) return { kind: "rejected" };
				try {
					exit = (await actions.makeCurrent(selectedName, signal)) === "exit";
					return exit ? { kind: "close" } : { kind: "stay" };
				} catch (error) {
					notifySetupChangeError(ctx, selectedName, error, signal);
					return { kind: "stay" };
				}
			},
			files: async () => {
				if (!selectedName) return { kind: "rejected" };
				const { showFileSelection } = await import("./file-selection.js");
				await showFileSelection(ctx, selectedName, signal);
				return { kind: "stay" };
			},
			edit: async () => {
				if (!selectedName) return { kind: "rejected" };
				try {
					await actions.edit(selectedName, signal);
				} catch (error) {
					notifySetupChangeError(ctx, selectedName, error, signal);
				}
				return { kind: "stay" };
			},
			remove: async () => {
				if (!selectedName) return { kind: "rejected" };
				const name = selectedName;
				try {
					await actions.remove(name, signal);
					selectedName = undefined;
					return { kind: "back" };
				} catch (error) {
					notifySetupChangeError(ctx, name, error, signal);
					return { kind: "stay" };
				}
			},
			back: async () => {
				selectedName = undefined;
				return { kind: "back" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: async () => loadSetupMenuState(selectedName, signal),
		signal,
		isCurrent: () => !signal?.aborted,
	});
	return exit ? "exit" : undefined;
}

async function loadSetupMenuState(
	selectedName: string | undefined,
	signal?: AbortSignal,
): Promise<SetupMenuState> {
	const raw = await readLocalConfigObject();
	if (signal?.aborted) throw signal.reason;
	const setups = ownRecord(raw?.syncSetups) ?? {};
	const active =
		typeof raw?.activeSyncSetup === "string" ? raw.activeSyncSetup : undefined;
	if (!selectedName || !ownRecord(setups[selectedName]))
		return { setups, active };
	const setupCount = Object.keys(setups).length;
	const isCurrent = selectedName === active;
	let detail: string[];
	let valid = true;
	try {
		const config = await loadConfig(selectedName);
		if (signal?.aborted) throw signal.reason;
		const selection = syncIncludeSelection(config.include);
		const summary = summarizeIncludedContent(config.include);
		detail = [
			`Status: ${isCurrent ? "Current" : "Not current"}`,
			`Storage connection: ${safeTerminalText(config.connectionName)}`,
			`Endpoint: ${safeGitRemote(config.backend.profile.remote)}`,
			`Storage location: ${safeTerminalText(`Git · ${config.backend.destination.branch}:${config.storagePath}`)}`,
			`Included content: ${summary.categoryCount} categor${summary.categoryCount === 1 ? "y" : "ies"} (${summary.pathCount} path${summary.pathCount === 1 ? "" : "s"})${summary.extraCount > 0 ? ` · ${summary.extraCount} extra path${summary.extraCount === 1 ? "" : "s"}` : ""}`,
			`Sessions: ${selection.sessions ? "On — privacy-sensitive" : "Off"}`,
			`Automatic sync: ${config.automatic ? "On" : "Off"}`,
		];
	} catch (error) {
		valid = false;
		detail = [
			`Status: Invalid${isCurrent ? " current setup" : ""}`,
			`Reason: ${safeTerminalText(errorMessage(error))}`,
			"Make current and sync are unavailable until this setup is repaired.",
		];
	}
	const removeUnavailable = isCurrent && setupCount > 1;
	if (removeUnavailable)
		detail.push("Remove unavailable: switch to another setup first.");
	return {
		setups,
		active,
		selected: { name: selectedName, detail, valid, removeUnavailable },
	};
}

function notifySetupChangeError(
	ctx: ExtensionCommandContext,
	name: string,
	error: unknown,
	signal?: AbortSignal,
) {
	if (signal?.aborted) return;
	ctx.ui.notify(
		`Sync setup “${safeTerminalText(name)}” was not changed: ${safeTerminalText(errorMessage(error))} Reopen it and retry.`,
		"error",
	);
}
