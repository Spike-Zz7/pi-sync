import { toPosix } from "./paths.js";
import {
	canonicalSnapshotPathForConfig,
	filterSnapshotForConfigPolicy,
	isConfiguredSnapshotPath,
	isSessionPath,
} from "./snapshot.js";
import type { RemoteHead } from "./sync-backend.js";
import {
	customIncludePathsByLower,
	includeFromSelectionConfig,
	normalizeSyncInclude,
	type SyncSelectionConfig,
} from "./sync-policy.js";
import type { Snapshot, SyncState } from "./types.js";

type SyncPolicyConfig = SyncSelectionConfig;

export type ContentSyncStatus =
	| "synced"
	| "local ahead"
	| "remote ahead"
	| "diverged";

export function contentSyncStatus(
	local: Snapshot,
	remote: Snapshot | undefined,
	state: SyncState,
	config: SyncPolicyConfig,
	ignoredPaths = new Set<string>(),
): ContentSyncStatus {
	// A disappeared branch is not an authoritative empty snapshot.
	if (!remote && state.lastAppliedSnapshot) return "diverged";
	const localHashes = withoutHashPaths(fileHashMap(local), ignoredPaths);
	const remoteHashes = remote
		? withoutHashPaths(fileHashMap(remote), ignoredPaths)
		: {};
	if (sameHashes(localHashes, remoteHashes)) return "synced";
	if (!state.lastAppliedSnapshot) {
		if (Object.keys(localHashes).length === 0) return "remote ahead";
		if (Object.keys(remoteHashes).length === 0) return "local ahead";
		return "diverged";
	}
	const localChanged = hasLocalChanges(local, state, config, ignoredPaths);
	const remoteChanged = remote
		? hasRemoteChanges(remote, state, config, ignoredPaths)
		: false;
	if (localChanged && remoteChanged) return "diverged";
	return localChanged ? "local ahead" : "remote ahead";
}

export function hasLocalChanges(
	local: Snapshot,
	state: SyncState,
	config: SyncPolicyConfig,
	ignoredPaths = new Set<string>(),
) {
	return !snapshotHashesMatchState(local, state, config, ignoredPaths);
}

export function remoteChangedSinceState(
	head: RemoteHead | undefined,
	state: SyncState,
	config: SyncPolicyConfig,
	sameRevision: (left: string, right: string) => boolean,
) {
	if (!head) return Boolean(state.lastAppliedSnapshot);
	if (head.snapshotId !== state.lastAppliedSnapshot) return true;
	if (
		state.lastRemoteRevision &&
		!sameRevision(head.revision, state.lastRemoteRevision)
	)
		return true;
	if (syncIncludeChanged(state, config)) return true;
	return (
		includeFromSelectionConfig(config).includes("sessions") &&
		!state.include?.includes("sessions") &&
		head.syncSessions
	);
}

export function hasRemoteChanges(
	remote: Snapshot,
	state: SyncState,
	config: SyncPolicyConfig,
	ignoredPaths = new Set<string>(),
) {
	return !snapshotHashesMatchState(
		filterSnapshotForConfigPolicy(remote, config),
		state,
		config,
		ignoredPaths,
	);
}

export function sameHashes(
	left: Record<string, string>,
	right: Record<string, string>,
) {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) if (left[key] !== right[key]) return false;
	return true;
}

export function fileHashMap(snapshot: Snapshot) {
	return Object.fromEntries(
		snapshot.files.map((file) => [file.path, file.sha256]),
	);
}

function stateHashMapForConfig(state: SyncState, config: SyncPolicyConfig) {
	const includePaths = customIncludePathsByLower(
		includeFromSelectionConfig(config),
	);
	return Object.fromEntries(
		Object.entries(state.lastFileHashes)
			.filter(([filePath]) => isConfiguredSnapshotPath(filePath, config))
			.map(([filePath, hash]) => [
				canonicalSnapshotPathForConfig(filePath, includePaths),
				hash,
			]),
	);
}

export function snapshotHashesMatchState(
	snapshot: Snapshot,
	state: SyncState,
	config: SyncPolicyConfig,
	ignoredPaths = new Set<string>(),
) {
	return sameHashes(
		withoutHashPaths(fileHashMap(snapshot), ignoredPaths),
		withoutHashPaths(stateHashMapForConfig(state, config), ignoredPaths),
	);
}

export function snapshotsMatch(left: Snapshot, right: Snapshot) {
	return (
		left.syncSessions === right.syncSessions &&
		sameHashes(fileHashMap(left), fileHashMap(right))
	);
}

function withoutHashPaths(
	hashes: Record<string, string>,
	ignoredPaths: Set<string>,
) {
	if (ignoredPaths.size === 0) return hashes;
	return Object.fromEntries(
		Object.entries(hashes).filter(
			([filePath]) => !ignoredPaths.has(toPosix(filePath)),
		),
	);
}

export function syncPolicyChanged(state: SyncState, config: SyncPolicyConfig) {
	return syncIncludeChanged(state, config);
}

export function shouldRefreshSyncedState(
	remote: Snapshot,
	head: RemoteHead | undefined,
	state: SyncState,
	config: SyncPolicyConfig,
	sameRevision: (left: string, right: string) => boolean,
) {
	return (
		remote.id !== state.lastAppliedSnapshot ||
		Boolean(
			head &&
				(!state.lastRemoteRevision ||
					!sameRevision(head.revision, state.lastRemoteRevision)),
		) ||
		syncPolicyChanged(state, config)
	);
}

function syncIncludeChanged(state: SyncState, config: SyncPolicyConfig) {
	const stored = state.include
		? normalizeSyncInclude(state.include)
		: includeFromSelectionConfig(state);
	const current = includeFromSelectionConfig(config);
	return (
		stored.length !== current.length ||
		stored.some((item, index) => item !== current[index])
	);
}

export function settingsHashMap(snapshot: Snapshot) {
	return Object.fromEntries(
		snapshot.files
			.filter((file) => !isSessionPath(file.path))
			.map((file) => [file.path, file.sha256]),
	);
}

export function sessionHashMap(snapshot: Snapshot) {
	return Object.fromEntries(
		snapshot.files
			.filter((file) => isSessionPath(file.path))
			.map((file) => [file.path, file.sha256]),
	);
}

export function settingsHashMapFromState(state: SyncState) {
	return Object.fromEntries(
		Object.entries(state.lastFileHashes).filter(
			([filePath]) => !isSessionPath(filePath),
		),
	);
}

export function settingsHashesMatchState(remote: Snapshot, state: SyncState) {
	return sameHashes(settingsHashMap(remote), settingsHashMapFromState(state));
}
