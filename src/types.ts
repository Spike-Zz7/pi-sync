export type StorageConnectionType = "git";
export type OnSwitchAction =
	| "ask-before-pull"
	| "pull-after-switch"
	| "switch-only";

export interface GitStorageConnectionSettings {
	type: "git";
	remote: string;
	[key: string]: unknown;
}

export type StorageConnectionSettings = GitStorageConnectionSettings;

export interface SyncSetupStorageSettings {
	connection: string;
	branch: string;
	path: string;
	[key: string]: unknown;
}

export type GitSyncSetupStorageSettings = SyncSetupStorageSettings;
export type CommonSyncSetupStorageSettings = SyncSetupStorageSettings;

export interface SyncPolicySettings {
	include: string[];
	automatic: boolean;
	[key: string]: unknown;
}

export interface SyncSetupSettings {
	storage: SyncSetupStorageSettings;
	sync: SyncPolicySettings;
	[key: string]: unknown;
}

export interface PiSyncSettingsV3 {
	version: 3;
	activeSyncSetup?: string;
	onSwitch: OnSwitchAction;
	skipSecretScan?: boolean;
	storageConnections: Record<string, StorageConnectionSettings>;
	syncSetups: Record<string, SyncSetupSettings>;
	[key: string]: unknown;
}

export interface ResolvedGitStorageProfile {
	kind: "git";
	remote: string;
}

/** Backend-only coordinates. `directory` is the complete reviewed v3 storage path. */
export interface ResolvedGitDestination {
	branch: string;
	directory: string;
	namespace: string;
}

export interface ResolvedGitBackend {
	type: "git";
	profile: ResolvedGitStorageProfile;
	destination: ResolvedGitDestination;
}

export type ResolvedSyncBackend = ResolvedGitBackend;

export interface SyncConfig {
	setupName: string;
	connectionName: string;
	storagePath: string;
	/** Snapshot/wire identity retained behind the settings normalization boundary. */
	snapshotIdentity: string;
	include: string[];
	automatic: boolean;
	onSwitch: OnSwitchAction;
	skipSecretScan: boolean;
	backend: ResolvedGitBackend;
}

export type AnySyncConfig = SyncConfig;
export type CommonSyncConfig = Omit<SyncConfig, "backend">;

/** UI projection over a fully validated v3 setup; it is never persisted directly. */
export interface PartialConfig {
	setupName: string;
	connectionName: string;
	storageKind: StorageConnectionType;
	storagePath: string;
	include: string[];
	automatic: boolean;
	onSwitch: OnSwitchAction;
	branch: string;
}

export interface SnapshotFile {
	mode?: number;
	path: string;
	contentBase64: string;
	sha256: string;
}

export interface SnapshotSelection {
	version: 1;
	include: string[];
}

export interface Snapshot {
	version: number;
	id: string;
	createdAt: string;
	machine: string;
	/** Backend-scoped remote identity retained in the snapshot wire format. */
	profile: string;
	syncSessions?: boolean;
	/** Portable, credential-free included-content intent. Absent on legacy snapshots. */
	selection?: SnapshotSelection;
	files: SnapshotFile[];
}

export interface SyncState {
	version: number;
	profile: string;
	lastAppliedSnapshot?: string;
	lastRemoteRevision?: string;
	lastFileHashes: Record<string, string>;
	include?: string[];
	/** Legacy state fields are read only so v3 can detect and replace stale policy state. */
	syncFiles?: string[];
	syncSessions?: boolean;
	extraFiles?: string[];
}

export interface LockFile {
	id: string;
	pid: number;
	command: string;
	startedAt: string;
}

export interface CommandOptions {
	yes: boolean;
	force: boolean;
	stale: boolean;
	silent: boolean;
	reload: boolean;
	auto: boolean;
	setup?: string;
	signal?: AbortSignal;
	onCommit?: () => void;
	args: string[];
}

export interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

export interface SnapshotOptions {
	strictEnvironment?: boolean;
	include?: string[];
	sessionDir?: string;
	/** Temporary internal projections while snapshot storage remains wire-compatible. */
	syncFiles?: string[];
	syncSessions?: boolean;
	extraFiles?: string[];
}

export interface SnapshotApplyPlan {
	writes: Array<{ target: string; content: Buffer; mode?: number }>;
	deletes: string[];
}
