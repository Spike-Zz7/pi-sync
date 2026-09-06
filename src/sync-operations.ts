import fs from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	loadConfig,
	readStateForConfig,
	sessionDirForApply,
	sessionDirFromContext,
	stateDir,
	syncConfigReviewFingerprint,
	syncSessionsWarnings,
	writeStateForConfig,
} from "./config.js";
import { inspectLock, isLockGuardHeld, withLock } from "./lock.js";
import {
	createSnapshot,
	filterSnapshotForConfigPolicy,
	mergeRemotePreservedFiles,
	regenerateSnapshotIdentity,
	scanSnapshot,
	sessionSnapshotPathFromAbsolute,
	snapshotIncludesSessions,
	snapshotWithoutSessions,
} from "./snapshot.js";
import { applySnapshot } from "./snapshot-apply.js";
import { encodeSnapshot } from "./snapshot-codec.js";
import {
	createSyncBackend,
	expectedRemoteHead,
	type PublishSnapshotResult,
	type RemoteHead,
	readSnapshotForHead,
	type SyncBackend,
	type SyncBackendFactory,
} from "./sync-backend.js";
import { createSyncDecision } from "./sync-decision.js";
import {
	countPreservedRemoteFiles,
	errorMessage,
	formatDiffSummary,
	formatDoctorMessages,
	formatPullSummary,
	formatPushSummary,
	formatRollbackSummary,
	formatSnapshotHistoryLabel,
	formatStatusSummary,
	safeTerminalText,
} from "./sync-format.js";
import {
	inspectRemoteSelection,
	remoteSelectionMismatch,
	requireCompatibleRemoteSelection,
} from "./sync-policy.js";
import {
	canPullRemoteSessionsOnFirstSync,
	canPullRemoteSettingsOnFirstSync,
	fileHashMap,
	hasLocalChanges,
	hasRemoteChanges,
	remoteChangedSinceState,
	sameHashes,
	shouldRefreshSyncedState,
	snapshotHashesMatchState,
	snapshotsMatch,
	syncPolicyChanged,
} from "./sync-state.js";
import type {
	AnySyncConfig,
	CommandOptions,
	Snapshot,
	SnapshotOptions,
	SyncState,
} from "./types.js";

const STATUS_KEY = "sync";
const VERSION = 1;
const DEFAULT_PROFILE = "default";
const POST_LOCAL_COMMIT_TIMEOUT_MS = 30_000;

export class PublicationStatePersistenceError extends Error {
	constructor(
		readonly head: RemoteHead,
		cause: unknown,
		readonly backupPath?: string,
	) {
		super(
			`Remote publication ${head.snapshotId} is active, but local sync state could not be saved${backupPath ? `; local backup: ${backupPath}` : ""}: ${errorMessage(cause)}`,
			{ cause },
		);
		this.name = "PublicationStatePersistenceError";
	}
}

export class RollbackPublicationError extends Error {
	constructor(
		readonly backupPath: string,
		cause: unknown,
	) {
		super(
			`Rollback applied locally with backup ${backupPath}, but remote publication failed: ${errorMessage(cause)}`,
			{ cause },
		);
		this.name = "RollbackPublicationError";
	}
}

interface PushInput {
	config: AnySyncConfig;
	state: SyncState;
	local: Snapshot;
	backend?: SyncBackend;
}

const sessionAwareTitle = (
	verb: "Push" | "Pull" | "Rollback",
	snapshot?: Snapshot,
) =>
	snapshot && snapshotIncludesSessions(snapshot)
		? `${verb} pi settings and sessions?`
		: `${verb} pi settings?`;

function notifySnapshotResult(
	ctx: ExtensionCommandContext | ExtensionContext,
	prefix: string,
	warnings: readonly string[],
) {
	ctx.ui.notify(
		[prefix, ...warnings].filter(Boolean).join("\n"),
		warnings.length > 0 ? "warning" : "info",
	);
}

function localSnapshotForContext(
	ctx: ExtensionCommandContext | ExtensionContext,
	config: AnySyncConfig,
) {
	return createSnapshot(
		config.snapshotIdentity,
		snapshotOptionsForContext(ctx, config),
	);
}

async function backupAndApplyRemote(
	ctx: ExtensionCommandContext | ExtensionContext,
	config: AnySyncConfig,
	remote: Snapshot,
	options: CommandOptions,
) {
	const backup = await backupLocal(
		config.snapshotIdentity,
		snapshotOptionsForContext(ctx, config),
		options.signal,
	);
	const applySessionDir = await sessionDirForApply(ctx, remote);
	throwIfAborted(options.signal);
	options.onCommit?.();
	const lastFileHashes = await applySnapshot(
		remote,
		protectedSessionPaths(ctx),
		{
			include: config.include,
			sessionDir: applySessionDir,
		},
	);
	return { backup, lastFileHashes };
}

function divergedDecision(
	kind:
		| "both-changed"
		| "first-sync-settings-diverged"
		| "first-sync-sessions-diverged",
	config: AnySyncConfig,
	state: SyncState,
	local: Snapshot,
	remote: Snapshot | undefined,
	directMessage: string,
) {
	return createSyncDecision({
		kind,
		config,
		state,
		local,
		remote,
		localChanged: true,
		remoteChanged: true,
		directMessage,
	});
}

function recordAppliedState(
	config: AnySyncConfig,
	snapshotId: string,
	lastRemoteRevision: string | undefined,
	lastFileHashes: Record<string, string>,
) {
	return writeStateForConfig(config, {
		version: VERSION,
		profile: config.snapshotIdentity,
		lastAppliedSnapshot: snapshotId,
		lastRemoteRevision,
		lastFileHashes,
		include: [...config.include],
	});
}

async function persistPublicationState(
	config: AnySyncConfig,
	head: RemoteHead,
	lastFileHashes: Record<string, string>,
	backupPath?: string,
) {
	try {
		await recordAppliedState(
			config,
			head.snapshotId,
			head.revision,
			lastFileHashes,
		);
	} catch (error) {
		throw new PublicationStatePersistenceError(head, error, backupPath);
	}
}

export async function status(
	ctx: ExtensionCommandContext,
	options: CommandOptions,
	factory: SyncBackendFactory = createSyncBackend,
) {
	const config = await loadConfig(options.setup);
	throwIfAborted(options.signal);
	ctx.ui.setStatus(STATUS_KEY, `checking ${config.setupName}`);
	const backend = await factory(config);
	const local = await localSnapshotForContext(ctx, config);
	throwIfAborted(options.signal);
	const state = await readStateForConfig(config);
	throwIfAborted(options.signal);
	const head = await backend.readHead(options.signal);
	throwIfAborted(options.signal);
	const selectionState = head
		? inspectRemoteSelection(config.include, {
				selection: head.selection,
				files: [],
			})
		: undefined;
	const localChanged = hasLocalChanges(local, state, config);
	const remoteChanged = remoteChangedSinceState(
		head,
		state,
		config,
		(left, right) => backend.sameRevision(left, right),
	);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	const { text, level } = formatStatusSummary(
		config,
		backend,
		local,
		state,
		head,
		selectionState,
		localChanged,
		remoteChanged,
		syncSessionsWarnings(config),
	);
	ctx.ui.notify(text, level);
}

export async function diff(
	ctx: ExtensionCommandContext,
	options: CommandOptions,
	factory: SyncBackendFactory = createSyncBackend,
) {
	const config = await loadConfig(options.setup);
	throwIfAborted(options.signal);
	ctx.ui.setStatus(STATUS_KEY, `checking ${config.setupName}`);
	const backend = await factory(config);
	const local = await localSnapshotForContext(ctx, config);
	throwIfAborted(options.signal);
	const { snapshot: remote, selectionState } = await readRemoteSnapshot(
		backend,
		config,
		options.signal,
		{ allowSelectionDifference: true },
	);
	throwIfAborted(options.signal);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	const { text, level } = formatDiffSummary(
		config,
		backend,
		local,
		remote,
		selectionState,
		syncSessionsWarnings(config),
	);
	ctx.ui.notify(text, level);
}

export async function doctor(
	ctx: ExtensionCommandContext,
	options: CommandOptions,
	factory: SyncBackendFactory = createSyncBackend,
) {
	let config: AnySyncConfig | undefined;
	let backend: SyncBackend | undefined;
	let configError: unknown;

	try {
		config = await loadConfig(options.setup);
		throwIfAborted(options.signal);
		backend = await factory(config);
	} catch (error) {
		throwIfAborted(options.signal);
		configError = error;
	}

	const local = await createSnapshot(
		config?.snapshotIdentity ?? DEFAULT_PROFILE,
		config ? snapshotOptionsForContext(ctx, config) : {},
	);
	throwIfAborted(options.signal);
	const lock = await inspectLock();
	throwIfAborted(options.signal);
	const guardHeld = lock.status === "missing" ? await isLockGuardHeld() : false;
	throwIfAborted(options.signal);
	const diagnostics = backend ? await backend.diagnose(options.signal) : [];
	throwIfAborted(options.signal);

	const { text, level } = formatDoctorMessages(
		config,
		backend,
		local,
		scanSnapshot(local),
		lock,
		guardHeld,
		config ? syncSessionsWarnings(config) : [],
		configError,
		diagnostics,
	);
	ctx.ui.notify(text, level);
}

export async function push(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: CommandOptions,
	input?: PushInput,
	factory: SyncBackendFactory = createSyncBackend,
) {
	const config = input?.config ?? (await loadConfig(options.setup));
	throwIfAborted(options.signal);
	ctx.ui.setStatus(STATUS_KEY, `pushing ${config.setupName}`);
	const backend = input?.backend ?? (await factory(config));
	const state = input?.state ?? (await readStateForConfig(config));
	throwIfAborted(options.signal);
	const local = input?.local ?? (await localSnapshotForContext(ctx, config));
	throwIfAborted(options.signal);

	let head = await backend.readHead(options.signal);
	let remoteForUpload = await readRemoteSnapshotForUpload(
		backend,
		config,
		head,
		state,
		options.signal,
	);
	if (!options.force) {
		if (
			!remoteForUpload &&
			head?.selection &&
			inspectRemoteSelection(config.include, {
				selection: head.selection,
				files: [],
			}).kind === "different"
		) {
			remoteForUpload = await readSnapshotForHead(
				backend,
				head,
				options.signal,
			);
		}
		if (remoteForUpload)
			requireCompatibleRemoteSelection(config, remoteForUpload);
		if (
			remoteChangedSinceState(head, state, config, (left, right) =>
				backend.sameRevision(left, right),
			)
		) {
			const remoteForConflict = remoteForUpload
				? filterSnapshotForConfigPolicy(remoteForUpload, config)
				: undefined;
			if (
				!remoteForConflict ||
				!snapshotHashesMatchState(remoteForConflict, state, config)
			) {
				throw createSyncDecision({
					kind: head ? "remote-or-policy-changed" : "remote-empty",
					config,
					state,
					local,
					remote: remoteForConflict,
					localChanged: hasLocalChanges(local, state, config),
					remoteChanged: true,
					directMessage:
						"Remote or sync policy changed since last sync. Run /sync pull first or /sync push --force.",
				});
			}
		}
	}

	async function prepareUpload(
		uploadHead: RemoteHead | undefined,
		remote: Snapshot | undefined,
	) {
		const uploadSnapshot = await snapshotForUpload(
			backend,
			config,
			local,
			uploadHead,
			remote,
			options.signal,
		);
		assertSafeUploadSnapshot(uploadSnapshot, config);
		return uploadSnapshot;
	}

	let upload = await prepareUpload(head, remoteForUpload);

	if (
		!(await confirmPush(
			ctx,
			options,
			config,
			backend,
			local,
			upload,
			head,
			remoteForUpload,
		))
	) {
		return "cancelled" as const;
	}

	if (options.force) {
		const refreshedHead = await backend.readHead(options.signal);
		if (!sameRemoteHead(backend, head, refreshedHead)) {
			head = refreshedHead;
			remoteForUpload = head
				? await backend.readSnapshot(head.snapshotRef, options.signal)
				: undefined;
			upload = await prepareUpload(head, remoteForUpload);
			if (
				!(await confirmPush(
					ctx,
					options,
					config,
					backend,
					local,
					upload,
					head,
					remoteForUpload,
					"Remote changed during review. Push the refreshed plan?",
				))
			) {
				return "cancelled" as const;
			}
		}
	}

	const result = await backend.publishSnapshot(
		upload,
		expectedRemoteHead(head),
		{
			signal: options.signal,
			onCommit: options.onCommit,
		},
	);
	await persistPublicationState(config, result.head, fileHashMap(local));
	if (options.signal?.aborted) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
	if (!options.silent) {
		notifySnapshotResult(
			ctx,
			`Pushed ${upload.files.length} files from sync setup “${config.setupName}” as ${result.head.snapshotId}.`,
			result.warnings,
		);
	}
	return "applied" as const;
}

export async function pull(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: CommandOptions,
	factory: SyncBackendFactory = createSyncBackend,
) {
	const config = await loadConfig(options.setup);
	throwIfAborted(options.signal);
	ctx.ui.setStatus(STATUS_KEY, `pulling ${config.setupName}`);
	const backend = await factory(config);
	const state = await readStateForConfig(config);
	throwIfAborted(options.signal);
	const local = await localSnapshotForContext(ctx, config);
	throwIfAborted(options.signal);
	const { head, snapshot: remote } = await readRemoteSnapshot(
		backend,
		config,
		options.signal,
	);
	throwIfAborted(options.signal);
	const localChanged = hasLocalChanges(local, state, config);
	if (!remote) {
		throw createSyncDecision({
			kind: "remote-empty",
			config,
			state,
			local,
			localChanged,
			remoteChanged: false,
			directMessage:
				"Remote is empty. Run /sync push from a configured machine first.",
		});
	}

	const remoteChanged = hasRemoteChanges(
		remote,
		state,
		config,
		protectedSessionPaths(ctx),
	);
	if (
		localChanged &&
		remoteChanged &&
		state.lastAppliedSnapshot &&
		!options.force
	) {
		throw divergedDecision(
			"both-changed",
			config,
			state,
			local,
			remote,
			"Both local and remote changed since last sync. Run /sync diff, then choose /sync pull --force or /sync push --force.",
		);
	}

	if (
		!(await confirmOperation(
			ctx,
			options,
			"Pull",
			sessionAwareTitle("Pull", remote),
			formatPullSummary(
				config,
				backend.destination,
				local,
				remote,
				protectedSessionPaths(ctx).size,
			),
		))
	) {
		return "cancelled" as const;
	}

	throwIfAborted(options.signal);
	const { backup, lastFileHashes } = await backupAndApplyRemote(
		ctx,
		config,
		remote,
		options,
	);
	await recordAppliedState(config, remote.id, head?.revision, lastFileHashes);
	if (options.signal?.aborted) return "applied" as const;
	ctx.ui.setStatus(STATUS_KEY, undefined);
	if (!options.silent) {
		ctx.ui.notify(
			`Pulled ${remote.files.length} files from ${remote.id}. Backup: ${backup}`,
			"info",
		);
	} else if (
		options.auto &&
		config.include.includes("sessions") &&
		snapshotIncludesSessions(remote)
	) {
		ctx.ui.notify(
			"Pulled Pi sessions after startup selected the current session. Restart Pi or resume a pulled session to use newly synced conversations.",
			"warning",
		);
	}
	if (options.reload) await maybeReload(ctx, options.signal);
	return "applied" as const;
}

export async function syncBoth(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: CommandOptions,
	factory: SyncBackendFactory = createSyncBackend,
) {
	const config = await loadConfig(options.setup);
	throwIfAborted(options.signal);
	const backend = await factory(config);
	const state = await readStateForConfig(config);
	throwIfAborted(options.signal);
	const local = await localSnapshotForContext(ctx, config);
	throwIfAborted(options.signal);
	if (config.include.length === 0) {
		if (!options.silent) {
			ctx.ui.notify(
				`Sync setup “${config.setupName}” includes no files. Choose included content in /sync Settings before syncing.`,
				"warning",
			);
		}
		return;
	}
	const { head, snapshot: remote } = await readRemoteSnapshot(
		backend,
		config,
		options.signal,
	);
	throwIfAborted(options.signal);
	const localChanged = hasLocalChanges(local, state, config);
	const remoteChanged = remote
		? hasRemoteChanges(remote, state, config, protectedSessionPaths(ctx))
		: false;
	const firstSync = !state.lastAppliedSnapshot;
	const markUpToDate = async (
		remoteSnapshot: Snapshot,
		message = "pi-sync is already up to date.",
	) => {
		await recordAppliedState(
			config,
			remoteSnapshot.id,
			head?.revision,
			fileHashMap(remoteSnapshot),
		);
		if (!options.silent) ctx.ui.notify(message, "info");
	};

	if (firstSync && remote?.files.length && local.files.length) {
		if (!canPullRemoteSettingsOnFirstSync(local, remote)) {
			throw divergedDecision(
				"first-sync-settings-diverged",
				config,
				state,
				local,
				remote,
				"Remote settings exist and this machine has different local Pi settings. Run /sync diff, then manually choose /sync pull or /sync push.",
			);
		}
		if (!sameHashes(fileHashMap(local), fileHashMap(remote))) {
			if (!canPullRemoteSessionsOnFirstSync(local, remote)) {
				throw divergedDecision(
					"first-sync-sessions-diverged",
					config,
					state,
					local,
					remote,
					"Remote settings match, but local and remote Pi sessions differ. Run /sync diff, then manually choose /sync pull or /sync push.",
				);
			}
			await pull(ctx, options, factory);
			return;
		}
		await markUpToDate(
			remote,
			"pi-sync state initialized; local settings already match remote.",
		);
		return;
	}
	if (
		localChanged &&
		remoteChanged &&
		remote &&
		snapshotsMatch(local, remote)
	) {
		await markUpToDate(remote);
		return;
	}
	if (localChanged && remoteChanged && state.lastAppliedSnapshot) {
		throw divergedDecision(
			"both-changed",
			config,
			state,
			local,
			remote,
			"Both local and remote changed. Run /sync diff and resolve with push --force or pull --force.",
		);
	}
	if (remoteChanged) return pull(ctx, options, factory);
	if (localChanged || !remote) return push(ctx, options, undefined, factory);
	if (
		shouldRefreshSyncedState(remote, head, state, config, (left, right) =>
			backend.sameRevision(left, right),
		)
	) {
		await recordAppliedState(
			config,
			remote.id,
			head?.revision,
			fileHashMap(remote),
		);
	}
	if (!options.silent) ctx.ui.notify("pi-sync is already up to date.", "info");
}

export async function history(
	ctx: ExtensionCommandContext,
	options: CommandOptions,
	factory: SyncBackendFactory = createSyncBackend,
) {
	const config = await loadConfig(options.setup);
	throwIfAborted(options.signal);
	const backend = await factory(config);
	const snapshots = (await backend.listHistory(options.signal))
		.slice(-20)
		.reverse();
	throwIfAborted(options.signal);
	if (snapshots.length === 0) {
		ctx.ui.notify("No remote pi-sync history found.", "info");
		return;
	}

	const currentSnapshot = snapshots[0]?.snapshotId;
	if (ctx.mode === "tui") {
		const labels = snapshots.map(
			(item, index) =>
				`${index + 1}. ${formatSnapshotHistoryLabel(item, item.snapshotId === currentSnapshot)}`,
		);
		const selected = await ctx.ui.select(
			`History for sync setup “${safeTerminalText(config.setupName)}”\n\nChoose a snapshot to preview rollback.`,
			[...labels, "Back"],
		);
		if (!selected || selected === "Back") return;
		throwIfAborted(options.signal);
		const snapshot = snapshots[labels.indexOf(selected)];
		if (!snapshot) return;
		await withLock("rollback", () =>
			rollback(
				ctx,
				{ ...options, args: [snapshot.snapshotRef], yes: false },
				factory,
				{
					backendIdentity: backend.identity,
					setup: config.setupName,
				},
			),
		);
		return;
	}
	ctx.ui.notify(
		snapshots
			.map(
				(item) =>
					`${item.snapshotRef} ${item.createdAt} ${safeTerminalText(item.machine)}`,
			)
			.join("\n"),
		"info",
	);
}

export async function rollback(
	ctx: ExtensionCommandContext,
	options: CommandOptions,
	factory: SyncBackendFactory = createSyncBackend,
	expectedSelection?: { backendIdentity: string; setup?: string },
) {
	const target = options.args[0];
	if (!target) throw new Error("Usage: /sync rollback <snapshot-id> [--yes]");

	const config = await loadConfig(options.setup);
	throwIfAborted(options.signal);
	const backend = await factory(config);
	if (
		expectedSelection &&
		(backend.identity !== expectedSelection.backendIdentity ||
			config.setupName !== expectedSelection.setup)
	) {
		throw new Error(
			"Sync setup or storage location changed while history was open; reopen history and retry.",
		);
	}
	const decoded = await backend.readSnapshot(target, options.signal);
	const selected = filterSnapshotForConfigPolicy(
		config.include.includes("sessions")
			? decoded
			: snapshotWithoutSessions(decoded),
		config,
	);
	const remote = regenerateSnapshotIdentity(selected);
	const local = await localSnapshotForContext(ctx, config);
	const expectedHead = await backend.readHead(options.signal);
	throwIfAborted(options.signal);

	if (
		!(await confirmOperation(
			ctx,
			options,
			"Rollback",
			sessionAwareTitle("Rollback", remote),
			formatRollbackSummary(
				config,
				backend.destination,
				local,
				remote,
				target,
				protectedSessionPaths(ctx).size,
			),
		))
	) {
		return;
	}

	throwIfAborted(options.signal);
	const { backup, lastFileHashes } = await backupAndApplyRemote(
		ctx,
		config,
		remote,
		options,
	);
	let result: PublishSnapshotResult;
	try {
		const completionSignal = AbortSignal.timeout(POST_LOCAL_COMMIT_TIMEOUT_MS);
		const upload = await snapshotForUpload(
			backend,
			config,
			remote,
			expectedHead,
			undefined,
			completionSignal,
			{ ignoreUnreadableRemote: true },
		);
		result = await backend.publishSnapshot(
			upload,
			expectedRemoteHead(expectedHead),
			{
				signal: completionSignal,
			},
		);
	} catch (error) {
		throw new RollbackPublicationError(backup, error);
	}
	await persistPublicationState(config, result.head, lastFileHashes, backup);
	if (options.signal?.aborted) return;
	notifySnapshotResult(
		ctx,
		`Rolled back sync setup “${config.setupName}” to ${target}; latest: ${result.head.snapshotId}. Backup: ${backup}`,
		result.warnings,
	);
	await maybeReload(ctx, options.signal);
}

function protectedSessionPaths(
	ctx: ExtensionCommandContext | ExtensionContext,
) {
	const sessionFile = ctx.sessionManager?.getSessionFile?.() as
		| string
		| undefined;
	const snapshotPath = sessionFile
		? sessionSnapshotPathFromAbsolute(sessionFile, sessionDirFromContext(ctx))
		: undefined;
	return snapshotPath ? new Set([snapshotPath]) : new Set<string>();
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

async function maybeReload(
	ctx: ExtensionCommandContext | ExtensionContext,
	signal?: AbortSignal,
) {
	if (signal?.aborted || !("reload" in ctx)) return;
	if (
		ctx.hasUI &&
		(await ctx.ui.confirm(
			"Reload Pi resources now?",
			"This reloads extensions, skills, prompts, themes, and context files.",
			{ signal },
		))
	) {
		if (signal?.aborted) return;
		await ctx.reload();
	}
}

async function readRemoteSnapshotForUpload(
	backend: SyncBackend,
	config: AnySyncConfig,
	head: RemoteHead | undefined,
	state: SyncState,
	signal?: AbortSignal,
) {
	if (
		!head ||
		(head.snapshotId === state.lastAppliedSnapshot &&
			!syncPolicyChanged(state, config) &&
			(!state.lastRemoteRevision ||
				backend.sameRevision(head.revision, state.lastRemoteRevision)))
	) {
		return undefined;
	}
	return backend.readSnapshot(head.snapshotRef, signal);
}

async function snapshotForUpload(
	backend: SyncBackend,
	config: AnySyncConfig,
	local: Snapshot,
	head: RemoteHead | undefined,
	remote?: Snapshot,
	signal?: AbortSignal,
	options: { ignoreUnreadableRemote?: boolean } = {},
) {
	if (!head) return local;
	let snapshot = remote;
	if (!snapshot) {
		try {
			snapshot = await backend.readSnapshot(head.snapshotRef, signal);
		} catch (error) {
			if (options.ignoreUnreadableRemote) return local;
			throw error;
		}
	}
	return mergeRemotePreservedFiles(local, snapshot, config);
}

function assertSafeUploadSnapshot(upload: Snapshot, config: AnySyncConfig) {
	if (!config.skipSecretScan) {
		const secrets = scanSnapshot(upload);
		if (secrets.length > 0) {
			throw new Error(
				`Refusing to push possible secrets:\n${secrets.map((s) => `- ${s}`).join("\n")}`,
			);
		}
	}
}

async function readRemoteSnapshot(
	backend: SyncBackend,
	config: AnySyncConfig,
	signal?: AbortSignal,
	options: { allowSelectionDifference?: boolean } = {},
) {
	const head = await backend.readHead(signal);
	if (!head)
		return { head: undefined, snapshot: undefined, selectionState: undefined };
	const snapshot = await readSnapshotForHead(backend, head, signal);
	const selectionState = inspectRemoteSelection(config.include, snapshot);
	if (
		!options.allowSelectionDifference &&
		selectionState.kind === "different"
	) {
		const configIdentity = syncConfigReviewFingerprint(config);
		throw remoteSelectionMismatch(
			config,
			selectionState.include,
			configIdentity,
		);
	}
	return {
		head,
		snapshot: filterSnapshotForConfigPolicy(snapshot, config),
		selectionState,
	};
}

async function confirmOperation(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: CommandOptions,
	verb: string,
	title: string,
	summary: string,
) {
	throwIfAborted(options.signal);
	if (options.yes) return true;
	const confirmed = await ctx.ui.confirm(title, summary, {
		signal: options.signal,
	});
	throwIfAborted(options.signal);
	if (confirmed) return true;
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(`${verb} cancelled.`, "info");
	return false;
}

async function confirmPush(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: CommandOptions,
	config: AnySyncConfig,
	backend: SyncBackend,
	local: Snapshot,
	upload: Snapshot,
	head: RemoteHead | undefined,
	remote: Snapshot | undefined,
	title = sessionAwareTitle("Push", upload),
) {
	return confirmOperation(
		ctx,
		options,
		"Push",
		title,
		formatPushSummary(
			config,
			backend.destination,
			upload,
			head,
			countPreservedRemoteFiles(local, upload),
			remote,
		),
	);
}

function throwIfAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}

function sameRemoteHead(
	backend: SyncBackend,
	left: RemoteHead | undefined,
	right: RemoteHead | undefined,
) {
	return !left || !right
		? left === right
		: backend.sameRevision(left.revision, right.revision);
}

export async function backupLocal(
	profile: string,
	options: SnapshotOptions = {},
	signal?: AbortSignal,
) {
	throwIfAborted(signal);
	const snapshot = await createSnapshot(profile, options);
	throwIfAborted(signal);
	const backupDirectory = path.join(stateDir(), "backups");
	await fs.mkdir(backupDirectory, { recursive: true });
	throwIfAborted(signal);
	const backupPath = path.join(backupDirectory, `${snapshot.id}.json.gz`);
	await fs.writeFile(backupPath, await encodeSnapshot(snapshot), { signal });
	return backupPath;
}
