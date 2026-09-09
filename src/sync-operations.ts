import fs from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	activeLocalConfigPath,
	agentDir,
	loadConfig,
	readLocalConfigObject,
	readStateForConfig,
	sessionDirForApply,
	sessionDirFromContext,
	stateDir,
	syncConfigReviewFingerprint,
	syncSessionsWarnings,
	validateSettingsDocument,
	writeStateForConfig,
} from "./config.js";
import {
	captureEnvironment,
	digest,
	type EnvironmentInstaller,
	environmentPath,
	prepareEnvironment,
	requireEnvironment,
} from "./environment.js";
import { environmentInstaller } from "./environment-installer.js";
import { withSyncSettingsLocks } from "./settings-lock.js";
import {
	createSnapshot,
	filterSnapshotForConfigPolicy,
	isConfiguredSnapshotPath,
	mergeRemotePreservedFiles,
	scanSnapshot,
	sessionSnapshotPathFromAbsolute,
	snapshotIncludesSessions,
	snapshotTarget,
} from "./snapshot.js";
import { applySnapshot } from "./snapshot-apply.js";
import { encodeSnapshot } from "./snapshot-codec.js";
import {
	createSyncBackend,
	expectedRemoteHead,
	type RemoteHead,
	readSnapshotForHead,
	type SyncBackend,
	type SyncBackendFactory,
} from "./sync-backend.js";
import { createSyncDecision } from "./sync-decision.js";
import {
	countPreservedRemoteFiles,
	errorMessage,
	formatPullSummary,
	formatPushSummary,
	safeTerminalText,
} from "./sync-format.js";
import {
	inspectRemoteSelection,
	sameSyncInclude,
	snapshotSelectionInclude,
} from "./sync-policy.js";
import {
	contentSyncStatus,
	fileHashMap,
	hasLocalChanges,
	remoteChangedSinceState,
	sameHashes,
	shouldRefreshSyncedState,
	snapshotHashesMatchState,
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
const _DEFAULT_PROFILE = "default";
const _POST_LOCAL_COMMIT_TIMEOUT_MS = 30_000;

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
	return createSnapshot(config.snapshotIdentity, {
		...snapshotOptionsForContext(ctx, config),
		strictEnvironment: true,
	});
}

async function backupAndApplyRemote(
	ctx: ExtensionCommandContext | ExtensionContext,
	config: AnySyncConfig,
	remote: Snapshot,
	options: CommandOptions,
	installer: EnvironmentInstaller,
) {
	const materialized = await prepareEnvironment(
		remote,
		agentDir(),
		installer,
		options.signal,
	);
	return withSyncSettingsLocks(async () => {
		const fresh = await loadConfig(options.setup);
		if (
			syncConfigReviewFingerprint(fresh) !== syncConfigReviewFingerprint(config)
		)
			throw new Error(
				"Sync destination or selection changed during install. Run /sync again.",
			);
		const include =
			remote.version === 2
				? (snapshotSelectionInclude(remote) ?? config.include)
				: config.include;
		const state = await readStateForConfig(config);
		const withdrawnPaths =
			remote.version === 2
				? Object.keys(state.lastFileHashes).filter(
						(file) =>
							!environmentPath(file) &&
							!isConfiguredSnapshotPath(file, { include }),
					)
				: [];
		for (const relative of withdrawnPaths) {
			const target = snapshotTarget(
				agentDir(),
				relative,
				sessionDirFromContext(ctx),
			);
			try {
				const stat = await fs.lstat(target);
				if (
					!stat.isFile() ||
					(!options.force &&
						digest(await fs.readFile(target)) !==
							state.lastFileHashes[relative])
				)
					throw new Error(
						"Previously managed withdrawn content changed locally. Review it before retrying sync.",
					);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const deletionInclude = include;
		const backup = await backupLocal(
			config.snapshotIdentity,
			{
				...snapshotOptionsForContext(ctx, config),
				include: [...new Set([...include, ...(state.include ?? [])])].filter(
					(item, _, all) =>
						!all.some(
							(parent) => parent !== item && item.startsWith(`${parent}/`),
						),
				),
			},
			options.signal,
		);
		const applySessionDir = await sessionDirForApply(ctx, remote);
		const additionalWrites = [];
		if (!sameSyncInclude(config.include, include)) {
			const configTarget = await activeLocalConfigPath();
			const currentConfig = await readLocalConfigObject();
			if (!currentConfig) throw new Error("Missing pi-sync settings.");
			const settings = structuredClone(currentConfig);
			if (!settings.syncSetups[config.setupName]) {
				throw new Error(`Sync setup “${config.setupName}” was not found.`);
			}
			settings.syncSetups[config.setupName].sync.include = include;
			validateSettingsDocument(settings);
			additionalWrites.push({
				target: configTarget,
				content: Buffer.from(`${JSON.stringify(settings, null, "\t")}\n`),
			});
		}
		throwIfAborted(options.signal);
		options.onCommit?.();
		const hashes = await applySnapshot(
			materialized,
			protectedSessionPaths(ctx),
			{
				include: deletionInclude,
				sessionDir: applySessionDir,
				additionalWrites,
				additionalDeletes: withdrawnPaths.map((file) =>
					snapshotTarget(agentDir(), file, applySessionDir),
				),
			},
		);
		const appliedConfig = { ...config, include };
		return {
			backup,
			config: appliedConfig,
			lastFileHashes: remote.version === 2 ? fileHashMap(remote) : hashes,
		};
	});
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
	const { snapshot: remote } = await readRemoteSnapshot(
		backend,
		config,
		options.signal,
	);
	throwIfAborted(options.signal);
	const result = contentSyncStatus(
		local,
		remote,
		state,
		config,
		protectedSessionPaths(ctx),
	);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(
		[
			`pi-sync: ${result}`,
			`Repository: ${safeTerminalText(config.backend.profile.remote)}`,
			`Branch: ${safeTerminalText(config.backend.destination.branch)}`,
			`Path: ${safeTerminalText(config.storagePath)}`,
			`Selected: ${config.include.map(safeTerminalText).join(", ") || "none"}`,
			"Remote checked; no content or sync baseline changed.",
			remote?.version === 2
				? "Strict shared scope: selected agent-global files, skills and packages; excludes project/CLI resources and OS tools."
				: "Legacy/empty target: no strict environment guarantee until a v2 publication.",
			...(result === "diverged"
				? [
						"Sync stopped safely: reconcile the selected content before syncing; neither side will be overwritten.",
					]
				: []),
			...syncSessionsWarnings(config),
		].join("\n"),
		result === "diverged" ? "warning" : "info",
	);
}

export async function push(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: CommandOptions,
	input?: PushInput,
	factory: SyncBackendFactory = createSyncBackend,
	installer: EnvironmentInstaller = environmentInstaller,
) {
	const config = input?.config ?? (await loadConfig(options.setup));
	throwIfAborted(options.signal);
	ctx.ui.setStatus(STATUS_KEY, `pushing ${config.setupName}`);
	const backend = input?.backend ?? (await factory(config));
	const state = input?.state ?? (await readStateForConfig(config));
	throwIfAborted(options.signal);
	const local = input?.local
		? await captureEnvironment(input.local, agentDir())
		: await localSnapshotForContext(ctx, config);
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
						"Remote content changed since last sync. Sync stopped safely; reconcile selected content before syncing.",
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

	await prepareEnvironment(upload, agentDir(), installer, options.signal);
	const result = await backend.publishSnapshot(
		upload,
		expectedRemoteHead(head),
		{
			signal: options.signal,
			onCommit: options.onCommit,
		},
	);
	try {
		const hasWithdrawn = Object.keys(state.lastFileHashes).some(
			(file) =>
				!environmentPath(file) && !isConfiguredSnapshotPath(file, config),
		);
		if (requireEnvironment(local)?.packages.length || hasWithdrawn) {
			const applied = await backupAndApplyRemote(
				ctx,
				config,
				local,
				options,
				installer,
			);
			await persistPublicationState(
				applied.config,
				result.head,
				applied.lastFileHashes,
				applied.backup,
			);
		} else
			await persistPublicationState(config, result.head, fileHashMap(local));
	} catch (error) {
		if (error instanceof PublicationStatePersistenceError) throw error;
		throw new PublicationStatePersistenceError(result.head, error);
	}
	if (options.signal?.aborted) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
	if (!options.silent) {
		notifySnapshotResult(
			ctx,
			`Pushed ${upload.files.filter((f) => !environmentPath(f.path)).length} files from sync setup “${config.setupName}” as ${result.head.snapshotId}.`,
			result.warnings,
		);
	}
	return "applied" as const;
}

export async function pull(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: CommandOptions,
	factory: SyncBackendFactory = createSyncBackend,
	installer: EnvironmentInstaller = environmentInstaller,
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
	const ignoredSessionPaths = protectedSessionPaths(ctx);
	const localChanged = hasLocalChanges(
		local,
		state,
		config,
		ignoredSessionPaths,
	);
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

	if (
		!options.force &&
		!state.lastAppliedSnapshot &&
		local.files.some((f) => !environmentPath(f.path)) &&
		!sameHashes(fileHashMap(local), fileHashMap(remote))
	) {
		throw divergedDecision(
			"first-sync-settings-diverged",
			config,
			state,
			local,
			remote,
			"No common baseline and selected content differs. Sync stopped safely; reconcile the content before syncing.",
		);
	}

	const direction = contentSyncStatus(
		local,
		remote,
		state,
		config,
		ignoredSessionPaths,
	);
	if (
		!options.force &&
		(direction === "diverged" || direction === "local ahead")
	) {
		throw divergedDecision(
			"both-changed",
			config,
			state,
			local,
			remote,
			"Selected local content changed. Sync stopped safely rather than replacing it with remote content.",
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
	const refreshed = await backend.readHead(options.signal);
	if (!sameRemoteHead(backend, head, refreshed))
		throw new Error("Remote changed during pull review. Run /sync again.");
	const {
		backup,
		lastFileHashes,
		config: appliedConfig,
	} = await backupAndApplyRemote(ctx, config, remote, options, installer);
	await recordAppliedState(
		appliedConfig,
		remote.id,
		head?.revision,
		lastFileHashes,
	);
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
	installer: EnvironmentInstaller = environmentInstaller,
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
				`Sync setup “${config.setupName}” includes no files. Choose content in /sync setup before syncing.`,
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
	if (remote?.version === 2) {
		const policy = snapshotSelectionInclude(remote) ?? config.include;
		if (
			!state.lastAppliedSnapshot ||
			(!sameSyncInclude(config.include, policy) &&
				sameSyncInclude(config.include, state.include ?? config.include))
		) {
			return pull(
				ctx,
				{ ...options, force: !state.lastAppliedSnapshot },
				factory,
				installer,
			);
		}
		if (sameHashes(fileHashMap(local), fileHashMap(remote))) {
			// Missing packages must be repaired even when the file baseline is current.
			const materialized = await prepareEnvironment(
				remote,
				agentDir(),
				installer,
				options.signal,
			);
			const settings = materialized.files.find(
				(f) => f.path === "settings.json",
			);
			if (
				settings &&
				(await fs.readFile(path.join(agentDir(), "settings.json"), "utf8")) !==
					Buffer.from(settings.contentBase64, "base64").toString("utf8")
			) {
				const applied = await backupAndApplyRemote(
					ctx,
					config,
					remote,
					options,
					installer,
				);
				await recordAppliedState(
					applied.config,
					remote.id,
					head?.revision,
					applied.lastFileHashes,
				);
			}
		}
	}
	const result =
		remote?.version === 2 &&
		!sameSyncInclude(config.include, snapshotSelectionInclude(remote))
			? sameSyncInclude(snapshotSelectionInclude(remote), state.include ?? [])
				? "local ahead"
				: "diverged"
			: contentSyncStatus(
					local,
					remote,
					state,
					config,
					protectedSessionPaths(ctx),
				);
	if (result === "diverged") {
		throw divergedDecision(
			state.lastAppliedSnapshot
				? "both-changed"
				: "first-sync-settings-diverged",
			config,
			state,
			local,
			remote,
			"Sync diverged: selected content changed on both sides, no common baseline exists, or the remote branch disappeared. Nothing was overwritten. Reconcile the selected content before syncing.",
		);
	}
	const checkedFactory: SyncBackendFactory = (current) => {
		if (
			syncConfigReviewFingerprint(current) !==
			syncConfigReviewFingerprint(config)
		) {
			throw new Error(
				"Sync destination or selection changed during comparison. Run /sync again.",
			);
		}
		return backend;
	};
	if (result === "remote ahead")
		return pull(ctx, options, checkedFactory, installer);
	if (result === "local ahead")
		return push(ctx, options, undefined, checkedFactory, installer);
	if (
		remote &&
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
	if (!options.silent) ctx.ui.notify("pi-sync: synced.", "info");
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
	return local.version === 2 && snapshot.version === 2
		? local
		: mergeRemotePreservedFiles(local, snapshot, config);
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
	_options: { allowSelectionDifference?: boolean } = {},
) {
	const head = await backend.readHead(signal);
	if (!head)
		return { head: undefined, snapshot: undefined, selectionState: undefined };
	const snapshot = await readSnapshotForHead(backend, head, signal);
	requireEnvironment(snapshot);
	const selectionState = inspectRemoteSelection(config.include, snapshot);

	return {
		head,
		snapshot: filterSnapshotForConfigPolicy(
			snapshot,
			snapshot.version === 2
				? { include: snapshotSelectionInclude(snapshot) ?? config.include }
				: config,
		),
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
