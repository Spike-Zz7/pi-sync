import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { RunRouteResult } from "./cancellable-operation.js";
import {
	completeSyncArguments,
	parseOptions,
	resolveSyncCommand,
	setSyncSetupCompletions,
	splitArgs,
	usage,
	validateCommandOptions,
} from "./command.js";
import {
	activeLocalConfigPath,
	configuredSyncSetupNames,
	consumeLocalConfigMigrationNotice,
	createLocalConfigDocument,
	ensureStateDir,
	isMissingConfigError,
	loadConfig,
	loadPartialConfig,
	localConfigPath,
	localConfigTemplate,
	readLocalConfigObject,
	readStateForConfig,
	sessionTokenWarnings,
	syncSessionsWarnings,
} from "./config.js";
import { unlock, withLock } from "./lock.js";
import { recoverSnapshotTransactionsOnStartup } from "./snapshot-transaction.js";
import {
	migrateLegacyStateDirectory,
	stateDirectoryMigrationNotice,
	withStateDirectoryAccess,
} from "./state-directory.js";
import {
	createSyncAttentionController,
	type SyncAttentionController,
	type SyncAttentionOrigin,
	syncAttentionMatchesConfig,
} from "./sync-attention.js";
import {
	errorMessage,
	isSyncDecisionRequiredError,
	SetupPullRequiresUiError,
} from "./sync-errors.js";
import {
	formatRemoteSelectionMismatch,
	type RemoteSelectionDecision,
	RemoteSelectionMismatchError,
} from "./sync-policy.js";
import type { AnySyncConfig, CommandOptions, SnapshotOptions } from "./types.js";

const STATUS_KEY = "sync";

type SetupSwitchModule = Pick<typeof import("./setup-switch.js"), "useSyncSetup">;
type SnapshotModule = Pick<typeof import("./snapshot.js"), "createSnapshot">;
type SyncStateModule = Pick<typeof import("./sync-state.js"), "hasLocalChanges">;
type SyncOperations = typeof import("./sync-operations.js");

export interface SyncDependencies {
	loadSetupSwitch(): Promise<SetupSwitchModule>;
	loadSnapshot(): Promise<SnapshotModule>;
	loadSyncState(): Promise<SyncStateModule>;
	loadSyncOperations(): Promise<SyncOperations>;
}

interface SyncLoaders {
	setupSwitch(): Promise<SetupSwitchModule>;
	snapshot(): Promise<SnapshotModule>;
	syncState(): Promise<SyncStateModule>;
	operations(): Promise<SyncOperations>;
}

const AUTO_SYNC_OPTIONS: CommandOptions = {
	yes: true,
	force: false,
	stale: false,
	silent: true,
	reload: false,
	auto: true,
	args: [],
};
export default function sync(pi: ExtensionAPI, dependencies: Partial<SyncDependencies> = {}) {
	const loaders: SyncLoaders = {
		setupSwitch: cachedModuleLoader(
			dependencies.loadSetupSwitch ?? (() => import("./setup-switch.js")),
		),
		snapshot: cachedModuleLoader(dependencies.loadSnapshot ?? (() => import("./snapshot.js"))),
		syncState: cachedModuleLoader(dependencies.loadSyncState ?? (() => import("./sync-state.js"))),
		operations: cachedModuleLoader(
			dependencies.loadSyncOperations ?? (() => import("./sync-operations.js")),
		),
	};
	const attention = createSyncAttentionController();
	let sessionAbort = new AbortController();
	let shutdownAbort: AbortController | undefined;

	pi.registerCommand("sync", {
		description: "Sync Pi settings through Git, WebDAV, R2, or S3-compatible storage",
		getArgumentCompletions: completeSyncArguments,
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				throw new Error(
					"/sync requires TUI or RPC mode so results and safety prompts are observable.",
				);
			}
			const run = () => handleCommand(args, ctx, sessionAbort.signal, loaders, attention);
			if (splitArgs(args)[0] === "migrate-state") await run();
			else await withStateDirectoryAccess(run);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		shutdownAbort?.abort(new DOMException("Session replaced", "AbortError"));
		shutdownAbort = undefined;
		sessionAbort.abort(new DOMException("Session replaced", "AbortError"));
		sessionAbort = new AbortController();
		const signal = sessionAbort.signal;
		attention.reset(ctx);
		let decision: RemoteSelectionDecision | undefined;
		try {
			decision = await withStateDirectoryAccess(() => startSession(ctx, signal, loaders));
		} catch (error) {
			if (signal.aborted) return;
			ctx.ui.notify(`pi-sync state access failed: ${errorMessage(error)}`, "error");
			return;
		}
		if (!decision || signal.aborted) return;
		attention.set(decision, "sync");
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				`pi-sync auto sync skipped: ${formatRemoteSelectionMismatch(
					decision.setupName,
					decision.localInclude,
					decision.remoteInclude,
				)}\nRPC review is read-only.`,
				"warning",
			);
		} else if (attention.markOffered()) {
			await resolveSelectionAttention(ctx, attention, signal, loaders, {
				cancelLabel: "Later",
				withStateAccess: withStateDirectoryAccess,
			});
		}
		if (!signal.aborted) attention.publish(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		sessionAbort.abort(new DOMException("Session shut down", "AbortError"));
		attention.reset(ctx);
		shutdownAbort?.abort(new DOMException("Session shut down again", "AbortError"));
		const controller = new AbortController();
		shutdownAbort = controller;
		const signal = combineSignals(controller.signal, AbortSignal.timeout(30_000));
		const reason =
			typeof event === "object" && event ? (event as { reason?: string }).reason : undefined;
		try {
			if (reason !== "reload") {
				await withStateDirectoryAccess(async () => {
					if (signal.aborted) return;
					await autoPushSessions(ctx, signal, loaders);
				});
			}
		} catch (error) {
			if (!signal.aborted) {
				ctx.ui.notify(`pi-sync session push skipped: ${errorMessage(error)}`, "warning");
			}
		} finally {
			if (shutdownAbort === controller) shutdownAbort = undefined;
		}
		if (signal.aborted) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

async function startSession(ctx: ExtensionContext, signal: AbortSignal, loaders: SyncLoaders) {
	if (signal.aborted) return;
	try {
		const migrationNotice = stateDirectoryMigrationNotice();
		if (migrationNotice) ctx.ui.notify(migrationNotice, "warning");
	} catch (error) {
		ctx.ui.notify(`pi-sync state directory requires attention: ${errorMessage(error)}`, "error");
		return;
	}
	try {
		await recoverSnapshotTransactionsOnStartup();
		if (signal.aborted) return;
	} catch (error) {
		if (signal.aborted) return;
		ctx.ui.notify(`pi-sync recovery required: ${errorMessage(error)}`, "error");
		return;
	}
	try {
		setSyncSetupCompletions(await configuredSyncSetupNames());
		if (signal.aborted) return;
	} catch {
		if (signal.aborted) return;
		setSyncSetupCompletions([]);
	}
	const migrationNotice = consumeLocalConfigMigrationNotice();
	if (migrationNotice) ctx.ui.notify(migrationNotice, "warning");
	if (signal.aborted) return;
	return autoSync(ctx, signal, loaders);
}

async function handleCommand(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	sessionSignal: AbortSignal,
	loaders: SyncLoaders,
	attention: SyncAttentionController,
) {
	if (!rawArgs.trim()) {
		try {
			const { showSyncManager } = await import("./manager-ui.js");
			if (sessionSignal.aborted) return;
			await showSyncManager(
				ctx,
				(route, signal, onCommit, target) =>
					executeCommand(
						route,
						ctx,
						combineSignals(sessionSignal, signal),
						loaders,
						onCommit,
						target,
					),
				sessionSignal,
				{
					getAttention: () => attention.current(),
					onSelectionResolved: (expected) => {
						if (attention.current() === expected) attention.clear(ctx);
					},
				},
			);
		} catch (error) {
			if (sessionSignal.aborted) return;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify(errorMessage(error), "error");
		}
		if (!sessionSignal.aborted) attention.publish(ctx);
		return;
	}
	const result = await executeCommand(rawArgs, ctx, sessionSignal, loaders);
	if (result.kind === "decision-required") {
		ctx.ui.notify(result.decision.directMessage, "error");
	} else if (result.kind === "remote-selection-required") {
		const origin = directSelectionOrigin(rawArgs);
		if (origin) attention.set(result.decision, origin);
		const deterministic = splitArgs(rawArgs).some((arg) => arg === "--yes" || arg === "-y");
		if (origin && ctx.mode === "tui" && !deterministic) {
			await resolveSelectionAttention(ctx, attention, sessionSignal, loaders);
		} else {
			ctx.ui.notify(
				formatRemoteSelectionMismatch(
					result.decision.setupName,
					result.decision.localInclude,
					result.decision.remoteInclude,
				),
				"error",
			);
		}
	}
	await clearAttentionAfterCompletedOperation(rawArgs, result, ctx, attention, sessionSignal);
	await reconcileSelectionAttention(ctx, attention, sessionSignal);
	if (!sessionSignal.aborted) attention.publish(ctx);
}

async function clearAttentionAfterCompletedOperation(
	rawArgs: string,
	result: RunRouteResult,
	ctx: ExtensionContext,
	attention: SyncAttentionController,
	signal: AbortSignal,
) {
	if (result.kind !== "completed" || result.outcome === "cancelled" || signal.aborted) return;
	const [command, ...rest] = splitArgs(rawArgs);
	if (command !== "sync" && command !== "pull" && command !== "push") return;
	const current = attention.current();
	if (!current) return;
	try {
		const options = parseOptions(rest);
		const setupName = options.setup ?? (await loadConfig()).setupName;
		if (signal.aborted || attention.current() !== current) return;
		if (current.decision.setupName === setupName) attention.clear(ctx);
	} catch {
		// Attention reconciliation below owns malformed or concurrently changed settings.
	}
}

async function reconcileSelectionAttention(
	ctx: ExtensionContext,
	attention: SyncAttentionController,
	signal: AbortSignal,
) {
	const current = attention.current();
	if (!current || signal.aborted) return;
	try {
		const config = await loadConfig(current.decision.setupName);
		if (signal.aborted || attention.current() !== current) return;
		if (!syncAttentionMatchesConfig(current, config)) attention.clear(ctx);
	} catch {
		if (!signal.aborted && attention.current() === current) attention.clear(ctx);
	}
}

function directSelectionOrigin(rawArgs: string): SyncAttentionOrigin | undefined {
	const command = splitArgs(rawArgs)[0];
	return command === "sync" || command === "pull" || command === "push" ? command : undefined;
}

async function resolveSelectionAttention(
	ctx: ExtensionContext,
	attention: SyncAttentionController,
	signal: AbortSignal,
	loaders: SyncLoaders,
	options: {
		cancelLabel?: string;
		withStateAccess?: <T>(task: () => Promise<T>) => Promise<T>;
	} = {},
) {
	const current = attention.current();
	if (!current || signal.aborted) return;
	const { dispatchManagerResult } = await import("./manager-result-dispatcher.js");
	if (signal.aborted || attention.current() !== current) return;
	await dispatchManagerResult(
		ctx,
		{ kind: "remote-selection-required", decision: current.decision },
		current.origin,
		(route, actionSignal, onCommit, target) => {
			const execute = () =>
				executeRecoveryCommand(
					route,
					ctx,
					combineSignals(signal, actionSignal),
					loaders,
					onCommit,
					target,
				);
			return options.withStateAccess ? options.withStateAccess(execute) : execute();
		},
		signal,
		{
			cancelLabel: options.cancelLabel,
			withStateAccess: options.withStateAccess,
			onSelectionResolved: () => {
				if (attention.current() === current) attention.clear(ctx);
			},
		},
	);
}

async function executeRecoveryCommand(
	rawArgs: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	loaders: SyncLoaders,
	onCommit?: () => void,
	setup?: string,
): Promise<RunRouteResult> {
	try {
		const [subcommand, ...rest] = splitArgs(rawArgs);
		if (subcommand !== "sync" && subcommand !== "pull" && subcommand !== "push") {
			throw new Error(`Unsupported sync recovery route: ${subcommand ?? "missing"}`);
		}
		const options = parseOptions(rest);
		if (setup !== undefined) options.setup = setup;
		if (signal) options.signal = signal;
		if (onCommit) options.onCommit = onCommit;
		options.reload = false;
		options.auto = false;
		validateCommandOptions(subcommand, options);
		const operations = await loaders.operations();
		throwIfAborted(options.signal);
		if (subcommand === "push") {
			const outcome = await withLock("push", () => operations.push(ctx, options));
			return { kind: "completed", ...(outcome ? { outcome } : {}) };
		}
		if (subcommand === "pull") {
			const outcome = await withLock("pull", () => operations.pull(ctx, options));
			return { kind: "completed", ...(outcome ? { outcome } : {}) };
		}
		await withLock("sync", () => operations.syncBoth(ctx, options));
		return { kind: "completed" };
	} catch (error) {
		if (signal?.aborted) return { kind: "failed" };
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (error instanceof RemoteSelectionMismatchError) {
			return { kind: "remote-selection-required", decision: error.decision };
		}
		if (isSyncDecisionRequiredError(error)) {
			return { kind: "decision-required", decision: error.decision };
		}
		ctx.ui.notify(errorMessage(error), "error");
		return { kind: "failed" };
	}
}

async function executeCommand(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	signal: AbortSignal | undefined,
	loaders: SyncLoaders,
	onCommit?: () => void,
	setup?: string,
): Promise<RunRouteResult> {
	try {
		const command = await resolveSyncCommand(rawArgs, ctx);
		if (signal?.aborted || !command) return { kind: "completed" };
		const { subcommand, rest } = command;
		const options = parseOptions(rest);
		if (setup !== undefined) options.setup = setup;
		if (signal) options.signal = signal;
		if (onCommit) options.onCommit = onCommit;
		validateCommandOptions(subcommand, options);

		switch (subcommand) {
			case "help":
				ctx.ui.notify(usage(), "info");
				return { kind: "completed" };
			case "use": {
				const { useSyncSetup } = await loaders.setupSwitch();
				throwIfAborted(options.signal);
				await useSyncSetup(
					ctx,
					options.args[0] ?? "",
					async (selectedSetup) => {
						const operations = await loaders.operations();
						throwIfAborted(options.signal);
						return withLock("pull", () =>
							operations.pull(ctx, { ...options, setup: selectedSetup }),
						);
					},
					undefined,
					options.signal,
				);
				return { kind: "completed" };
			}
			case "init":
				await initConfig(ctx, signal);
				return { kind: "completed" };
			case "config":
				await showConfig(ctx, options);
				return { kind: "completed" };
			case "files": {
				const { showFileSelection } = await import("./file-selection.js");
				throwIfAborted(options.signal);
				await showFileSelection(ctx, options.setup, options.signal);
				return { kind: "completed" };
			}
			case "status": {
				const operations = await loaders.operations();
				throwIfAborted(options.signal);
				await operations.status(ctx, options);
				return { kind: "completed" };
			}
			case "diff": {
				const operations = await loaders.operations();
				throwIfAborted(options.signal);
				await operations.diff(ctx, options);
				return { kind: "completed" };
			}
			case "doctor": {
				const operations = await loaders.operations();
				throwIfAborted(options.signal);
				await operations.doctor(ctx, options);
				return { kind: "completed" };
			}
			case "push": {
				const operations = await loaders.operations();
				throwIfAborted(options.signal);
				const outcome = await withLock("push", () => operations.push(ctx, options));
				return { kind: "completed", ...(outcome ? { outcome } : {}) };
			}
			case "pull": {
				const operations = await loaders.operations();
				throwIfAborted(options.signal);
				const outcome = await withLock("pull", () => operations.pull(ctx, options));
				return { kind: "completed", ...(outcome ? { outcome } : {}) };
			}
			case "sync": {
				const operations = await loaders.operations();
				throwIfAborted(options.signal);
				await withLock("sync", () => operations.syncBoth(ctx, options));
				return { kind: "completed" };
			}
			case "history": {
				const operations = await loaders.operations();
				throwIfAborted(options.signal);
				await operations.history(ctx, options);
				return { kind: "completed" };
			}
			case "rollback": {
				const operations = await loaders.operations();
				throwIfAborted(options.signal);
				await withLock("rollback", () => operations.rollback(ctx, options));
				return { kind: "completed" };
			}
			case "migrate-state":
				await migrateStateDirectory(ctx, options);
				return { kind: "completed" };
			case "unlock":
				await unlock(ctx, options);
				return { kind: "completed" };
			default:
				ctx.ui.notify(`Unknown /sync command: ${subcommand}\n\n${usage()}`, "warning");
				return { kind: "failed" };
		}
	} catch (error) {
		if (signal?.aborted) return { kind: "failed" };
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (error instanceof SetupPullRequiresUiError) throw error;
		if (error instanceof RemoteSelectionMismatchError) {
			return { kind: "remote-selection-required", decision: error.decision };
		}
		if (isSyncDecisionRequiredError(error)) {
			return { kind: "decision-required", decision: error.decision };
		}
		ctx.ui.notify(errorMessage(error), "error");
		return { kind: "failed" };
	}
}

async function migrateStateDirectory(ctx: ExtensionCommandContext, options: CommandOptions) {
	const notice = stateDirectoryMigrationNotice();
	if (!notice) {
		ctx.ui.notify("pi-sync already uses the canonical pi-sync/ state directory.", "info");
		return;
	}
	if (
		!options.yes &&
		!(await ctx.ui.confirm(
			"Migrate pi-sync state directory",
			"Confirm that every other Pi process is closed. pi-sync will atomically rename .pisync/ to pi-sync/ without merging or deleting either root.",
			{ signal: options.signal },
		))
	) {
		ctx.ui.notify("pi-sync state migration cancelled.", "info");
		return;
	}
	throwIfAborted(options.signal);
	const result = await migrateLegacyStateDirectory();
	throwIfAborted(options.signal);
	if (result.status === "ready") {
		ctx.ui.notify("pi-sync already uses the canonical pi-sync/ state directory.", "info");
		return;
	}
	ctx.ui.notify(result.message, result.status === "migrated" ? "info" : "warning");
}

async function autoSync(
	ctx: ExtensionContext,
	signal: AbortSignal,
	loaders: SyncLoaders,
): Promise<RemoteSelectionDecision | undefined> {
	try {
		const partial = await loadPartialConfig();
		throwIfAborted(signal);
		if (!partial.automatic) return;
		await ensureStateDir();
		throwIfAborted(signal);
		await loadConfig();
		throwIfAborted(signal);
		const operations = await loaders.operations();
		throwIfAborted(signal);
		await withLock("auto-sync", () => {
			throwIfAborted(signal);
			return operations.syncBoth(ctx, { ...AUTO_SYNC_OPTIONS, signal });
		});
	} catch (error) {
		if (signal.aborted || isMissingConfigError(error)) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (error instanceof RemoteSelectionMismatchError) return error.decision;
		ctx.ui.notify(`pi-sync auto sync skipped: ${errorMessage(error)}`, "warning");
	}
}

async function autoPushSessions(ctx: ExtensionContext, signal: AbortSignal, loaders: SyncLoaders) {
	try {
		const partial = await loadPartialConfig();
		throwIfAborted(signal);
		if (!partial.automatic) return;
		if (!partial.include.includes("sessions")) return;
		await ensureStateDir();
		throwIfAborted(signal);
		const config = await loadConfig();
		throwIfAborted(signal);
		if (!config.include.includes("sessions")) return;
		const [operations, snapshotModule, syncStateModule] = await Promise.all([
			loaders.operations(),
			loaders.snapshot(),
			loaders.syncState(),
		]);
		throwIfAborted(signal);
		await withLock("auto-session-push", async () => {
			throwIfAborted(signal);
			const state = await readStateForConfig(config);
			throwIfAborted(signal);
			const local = await snapshotModule.createSnapshot(
				config.snapshotIdentity,
				snapshotOptionsForContext(ctx, config),
			);
			throwIfAborted(signal);
			if (!syncStateModule.hasLocalChanges(local, state, config)) return;
			await operations.push(ctx, { ...AUTO_SYNC_OPTIONS, signal }, { config, state, local });
		});
	} catch (error) {
		if (signal.aborted || isMissingConfigError(error)) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(`pi-sync session push skipped: ${errorMessage(error)}`, "warning");
	}
}

async function initConfig(ctx: ExtensionCommandContext, signal?: AbortSignal) {
	const configPath = localConfigPath();
	if (await readLocalConfigObject()) {
		ctx.ui.notify(`Config already exists: ${await activeLocalConfigPath()}`, "info");
		return;
	}

	if (ctx.mode === "tui") {
		const { showSetupWizard } = await import("./manager-ui.js");
		throwIfAborted(signal);
		await showSetupWizard(ctx, signal);
		return;
	}
	await createLocalConfigDocument(localConfigTemplate());
	ctx.ui.notify(
		`Created ${configPath}. Add a storage connection and sync setup before syncing.`,
		"info",
	);
}

async function showConfig(ctx: ExtensionCommandContext, options: CommandOptions) {
	const config = await loadConfig(options.setup);
	const warnings = [
		...(config.backend.type === "s3" ? sessionTokenWarnings(config.backend.profile) : []),
		...syncSessionsWarnings(config),
	];
	const storageLines = configStorageLines(config);
	ctx.ui.notify(
		[
			"pi-sync config:",
			`sync setup: ${config.setupName}`,
			`storage connection: ${config.connectionName}`,
			...storageLines,
			`storage path: ${config.storagePath}`,
			`automatic sync: ${config.automatic ? "enabled" : "disabled"}`,
			`included content: ${config.include.join(", ") || "none"}`,
			`sessions: ${config.include.includes("sessions") ? "included" : "not included"}`,
			`settings file: ${localConfigPath()}`,
			...warnings,
		].join("\n"),
		warnings.length > 0 ? "warning" : "info",
	);
}

function configStorageLines(config: AnySyncConfig) {
	switch (config.backend.type) {
		case "git":
			return [
				"kind: git",
				`remote: ${displayGitRemote(config.backend.profile.remote)}`,
				"authentication: existing Git/SSH credentials (not stored)",
				`branch: ${config.backend.destination.branch}`,
			];
		case "webdav":
			return [
				"kind: webdav",
				`url: ${displayWebDavUrl(config.backend.profile.url, config.backend.profile.username)}`,
				"username: configured (value hidden)",
				"password: configured",
			];
		case "s3":
			return [
				"kind: s3",
				`endpoint: ${config.backend.profile.endpoint}`,
				`bucket: ${config.backend.destination.bucket}`,
				`region: ${config.backend.profile.region}`,
				"access key id: configured",
				"secret access key: configured",
				`session token: ${config.backend.profile.sessionToken ? "configured" : "not configured"}`,
			];
	}
}

function displayGitRemote(value: string | undefined) {
	if (!value) return "missing";
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return value.replace(/^(?:[^@\s]+@)?(?<host>[^:]+):.+$/u, "$<host>:…");
	}
}

function displayWebDavUrl(value: string | undefined, username: string | undefined) {
	if (!value) return "missing";
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return username ? `${url.origin}/…` : `${url.origin}${url.pathname}`;
	} catch {
		return "invalid (value hidden)";
	}
}

function throwIfAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}

function combineSignals(primary: AbortSignal, secondary?: AbortSignal) {
	return secondary ? AbortSignal.any([primary, secondary]) : primary;
}

function snapshotOptionsForContext(
	ctx: ExtensionCommandContext | ExtensionContext,
	config: AnySyncConfig,
): SnapshotOptions {
	return {
		include: config.include,
		sessionDir: sessionDirFromContext(ctx),
	};
}

function sessionDirFromContext(ctx: ExtensionCommandContext | ExtensionContext) {
	const manager = ctx.sessionManager as typeof ctx.sessionManager & {
		usesDefaultSessionDir?: () => boolean;
	};
	const usesDefaultSessionDir = manager.usesDefaultSessionDir;
	if (typeof usesDefaultSessionDir === "function" && usesDefaultSessionDir.call(manager)) {
		return undefined;
	}
	const getSessionDir = manager.getSessionDir;
	return typeof getSessionDir === "function"
		? (getSessionDir.call(manager) as string | undefined)
		: undefined;
}

function cachedModuleLoader<Module>(load: () => Promise<Module>): () => Promise<Module> {
	let pending: Promise<Module> | undefined;
	return () => {
		if (!pending) {
			pending = load().catch((error) => {
				pending = undefined;
				throw error;
			});
		}
		return pending;
	};
}
