import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	activeLocalConfigPath,
	consumeLocalConfigMigrationNotice,
	createLocalConfigDocument,
	legacyLocalConfigPath,
	localConfigPath,
	quarantineAndRemoveConfigIfMatches,
	readActiveLocalConfigDocumentForRepair,
	readMigratingLocalConfigDocument,
	replaceLocalConfigDocument,
	updateLocalConfigDocument,
} from "./config-file.js";
import {
	normalizeGitBranch,
	normalizeGitDirectory,
	normalizeGitRemote,
	normalizeGitRemoteIdentity,
} from "./git-config.js";
import { safeName } from "./paths.js";
import { stateDir } from "./state-directory.js";
import { normalizeSyncInclude } from "./sync-policy.js";
import type {
	AnySyncConfig,
	OnSwitchAction,
	PartialConfig,
	PiSyncSettingsV3,
	Snapshot,
	StorageConnectionSettings,
	SyncSetupSettings,
	SyncState,
} from "./types.js";

const STATE_VERSION = 2;
export const DEFAULT_ON_SWITCH: OnSwitchAction = "ask-before-pull";

export { normalizeExtraFiles, normalizeSyncFiles } from "./sync-policy.js";
export {
	activeLocalConfigPath,
	consumeLocalConfigMigrationNotice,
	createLocalConfigDocument,
	legacyLocalConfigPath,
	localConfigPath,
	normalizeSyncInclude,
	quarantineAndRemoveConfigIfMatches,
	readActiveLocalConfigDocumentForRepair,
	replaceLocalConfigDocument,
	updateLocalConfigDocument,
};

export function sessionDirFromContext(
	ctx: ExtensionCommandContext | ExtensionContext,
) {
	const manager = ctx.sessionManager as typeof ctx.sessionManager & {
		usesDefaultSessionDir?: () => boolean;
	};
	if (!manager) return undefined;
	if (manager.usesDefaultSessionDir?.call(manager)) return undefined;
	return typeof manager.getSessionDir === "function"
		? (manager.getSessionDir.call(manager) as string | undefined)
		: undefined;
}

export async function loadConfig(setupName?: string): Promise<AnySyncConfig> {
	const settings = await requireSettings();
	const selectedName = setupName ?? settings.activeSyncSetup;
	if (!selectedName) throw new Error("No sync setups are configured.");
	validateConfigName(selectedName, "sync setup");
	const setup = ownObject<SyncSetupSettings>(settings.syncSetups, selectedName);
	if (!setup)
		throw new Error(
			`Invalid pi-sync settings: sync setup “${selectedName}” was not found.`,
		);
	const connectionName = setup.storage.connection;
	const connection = ownObject<StorageConnectionSettings>(
		settings.storageConnections,
		connectionName,
	);
	if (!connection) {
		throw new Error(
			`Invalid pi-sync settings: sync setup “${selectedName}” references missing storage connection “${connectionName}”.`,
		);
	}
	return resolveSyncConfig(
		selectedName,
		setup,
		connectionName,
		connection,
		settings.onSwitch,
		settings.skipSecretScan ?? false,
	);
}

export type SyncSetupStorageReview = Pick<
	PartialConfig,
	"connectionName" | "storageKind" | "storagePath" | "branch"
>;

/** A validated setup-facing projection used by manager and settings UI. */
export async function loadPartialConfig(
	setupName?: string,
): Promise<PartialConfig> {
	const config = await loadConfig(setupName);
	return {
		setupName: config.setupName,
		...storageReviewFromConfig(config),
		include: [...config.include],
		automatic: config.automatic,
		onSwitch: config.onSwitch,
	};
}

export function syncSetupStorageReview(
	setupName: string,
	setup: SyncSetupSettings,
	connectionName: string,
	connection: StorageConnectionSettings,
): SyncSetupStorageReview {
	return storageReviewFromConfig(
		resolveSyncConfig(
			setupName,
			setup,
			connectionName,
			connection,
			DEFAULT_ON_SWITCH,
			false,
		),
	);
}

export function syncSetupReviewIdentity(
	setupName: string,
	setup: SyncSetupSettings,
	connectionName: string,
	connection: StorageConnectionSettings,
) {
	return syncConfigReviewIdentity(
		resolveSyncConfig(
			setupName,
			setup,
			connectionName,
			connection,
			DEFAULT_ON_SWITCH,
			false,
		),
	);
}

export function syncConfigReviewIdentity(config: AnySyncConfig) {
	return JSON.stringify([
		config.setupName,
		config.connectionName,
		backendIdentityCoordinates(config),
		config.include,
		config.automatic,
	]);
}

export function syncConfigReviewFingerprint(config: AnySyncConfig) {
	return createHash("sha256")
		.update(syncConfigReviewIdentity(config))
		.digest("hex");
}

function storageReviewFromConfig(
	config: AnySyncConfig,
): SyncSetupStorageReview {
	return {
		connectionName: config.connectionName,
		storageKind: config.backend.type,
		storagePath: config.storagePath,
		branch: config.backend.destination.branch,
	};
}

export async function configuredSyncSetupNames() {
	const settings = await readLocalConfigObject();
	return settings
		? Object.keys(settings.syncSetups).sort((left, right) =>
				left.localeCompare(right),
			)
		: [];
}

export async function loadOnSwitch(): Promise<OnSwitchAction> {
	return (await requireSettings()).onSwitch;
}

export function normalizeOnSwitch(value: unknown): OnSwitchAction {
	if (
		value === "ask-before-pull" ||
		value === "pull-after-switch" ||
		value === "switch-only"
	) {
		return value;
	}
	throw new Error(
		'Invalid pi-sync settings: onSwitch must be "ask-before-pull", "pull-after-switch", or "switch-only".',
	);
}

function resolveSyncConfig(
	setupName: string,
	setup: SyncSetupSettings,
	connectionName: string,
	connection: StorageConnectionSettings,
	onSwitch: OnSwitchAction,
	skipSecretScan: boolean,
): AnySyncConfig {
	const storagePath = normalizeStoragePath(setup.storage.path);
	const namespace =
		storagePath === "./"
			? "root"
			: storagePath.slice(storagePath.lastIndexOf("/") + 1);
	const include = normalizeSyncInclude(setup.sync.include);
	const common = {
		setupName,
		connectionName,
		storagePath,
		snapshotIdentity: namespace,
		include,
		automatic: setup.sync.automatic,
		onSwitch,
		skipSecretScan,
	};
	if (connection.type !== "git") {
		throw new Error(
			`Unsupported storage connection type: ${connection.type}. Only Git is supported.`,
		);
	}
	return {
		...common,
		backend: {
			type: "git",
			profile: {
				kind: "git",
				remote: normalizeGitRemote(connection.remote) as string,
			},
			destination: {
				branch: normalizeGitBranch(setup.storage.branch),
				directory: normalizeGitDirectory(storagePath),
				namespace,
			},
		},
	};
}

async function requireSettings() {
	const settings = await readLocalConfigObject();
	if (!settings) {
		throw new Error(
			`Missing pi-sync settings. Use /sync setup or create ${localConfigPath()}.`,
		);
	}
	return settings;
}

export function validateSettingsDocument(
	value: Record<string, unknown>,
): PiSyncSettingsV3 {
	if (value.version !== 3) {
		throw new Error(
			`Unsupported pi-sync settings: version 3 is required. Keep the existing file for recovery, then create a new version 3 ${path.basename(localConfigPath())}; pi-sync will not migrate or overwrite old settings.`,
		);
	}
	rejectLegacyFields(
		value,
		[
			"profiles",
			"targets",
			"activeTarget",
			"targetSwitchAction",
			"endpoint",
			"bucket",
			"region",
			"accessKeyId",
			"secretAccessKey",
			"sessionToken",
			"profile",
			"prefix",
			"autoSync",
			"syncFiles",
			"syncSessions",
			"extraFiles",
		],
		"top level",
	);
	normalizeOnSwitch(value.onSwitch);
	if (
		value.skipSecretScan !== undefined &&
		typeof value.skipSecretScan !== "boolean"
	) {
		throw new Error(
			"Invalid pi-sync settings: skipSecretScan must be boolean.",
		);
	}
	const storageConnections = requireNamedObjectMap(
		value.storageConnections,
		"storageConnections",
		"storage connection",
	);
	const syncSetups = requireNamedObjectMap(
		value.syncSetups,
		"syncSetups",
		"sync setup",
	);
	for (const name of Object.keys(storageConnections)) {
		validateStorageConnection(
			name,
			requireOwnObject(
				storageConnections,
				name,
				"storage connection",
			) as Record<string, unknown>,
		);
	}
	for (const name of Object.keys(syncSetups)) {
		validateSyncSetup(
			name,
			requireOwnObject(syncSetups, name, "sync setup") as Record<
				string,
				unknown
			>,
			storageConnections,
		);
	}
	const names = Object.keys(syncSetups);
	const activeSyncSetup = optionalCanonicalReference(
		value.activeSyncSetup,
		"activeSyncSetup",
	);
	if (names.length === 0) {
		if (activeSyncSetup !== undefined) {
			throw new Error(
				"Invalid pi-sync settings: empty syncSetups cannot have activeSyncSetup.",
			);
		}
	} else if (!activeSyncSetup || !Object.hasOwn(syncSetups, activeSyncSetup)) {
		throw new Error(
			"Invalid pi-sync settings: activeSyncSetup must reference an existing own-property sync setup.",
		);
	}
	validateUniqueRemoteSyncSetups(syncSetups, storageConnections);
	return value as PiSyncSettingsV3;
}

function validateStorageConnection(
	name: string,
	value: Record<string, unknown>,
) {
	rejectLegacyFields(
		value,
		[
			"kind",
			"accessKeyId",
			"secretAccessKey",
			"sessionToken",
			"username",
			"password",
		],
		`storage connection “${name}”`,
	);
	const type = requiredString(value.type, `storage connection "${name}" type`);
	if (type !== "git") {
		throw new Error(
			`Invalid pi-sync settings: storage connection "${name}" has unsupported type "${type}". Only Git is supported.`,
		);
	}
	if (
		!normalizeGitRemote(
			requiredString(value.remote, `Git remote for "${name}"`),
		)
	) {
		throw new Error(
			`Invalid pi-sync settings: Git remote for "${name}" is required.`,
		);
	}
}

function validateSyncSetup(
	name: string,
	value: Record<string, unknown>,
	connections: Record<string, unknown>,
) {
	rejectLegacyFields(
		value,
		[
			"profile",
			"bucket",
			"branch",
			"path",
			"prefix",
			"directory",
			"namespace",
			"autoSync",
			"syncFiles",
			"syncSessions",
			"extraFiles",
		],
		`sync setup “${name}”`,
	);
	const storage = requireRecord(
		value.storage,
		`storage for sync setup “${name}”`,
	);
	const sync = requireRecord(
		value.sync,
		`sync policy for sync setup “${name}”`,
	);
	rejectLegacyFields(
		storage,
		["profile", "prefix", "directory", "namespace"],
		`storage for sync setup “${name}”`,
	);
	rejectLegacyFields(
		sync,
		["autoSync", "syncFiles", "syncSessions", "extraFiles"],
		`sync policy for sync setup “${name}”`,
	);
	const connectionName = requiredCanonicalReference(
		storage.connection,
		`storage connection reference for sync setup “${name}”`,
	);
	validateConfigName(connectionName, "storage connection reference");
	const connection = ownObject<Record<string, unknown>>(
		connections,
		connectionName,
	);
	if (!connection) {
		throw new Error(
			`Invalid pi-sync settings: sync setup “${name}” references missing storage connection “${connectionName}”.`,
		);
	}
	normalizeStoragePath(
		requiredString(storage.path, `storage path for sync setup “${name}”`),
	);
	normalizeGitBranch(
		requiredString(storage.branch, `Git branch for sync setup "${name}"`),
	);
	if (Object.hasOwn(storage, "bucket")) {
		throw new Error(
			`Invalid pi-sync settings: Git sync setup “${name}” mixes backend fields.`,
		);
	}
	if (!Object.hasOwn(sync, "include")) {
		throw new Error(
			`Invalid pi-sync settings: sync setup “${name}” is missing sync.include.`,
		);
	}
	normalizeSyncInclude(sync.include);
	if (typeof sync.automatic !== "boolean") {
		throw new Error(
			`Invalid pi-sync settings: sync setup “${name}” sync.automatic must be boolean.`,
		);
	}
}

export function validateUniqueRemoteSyncSetups(
	setups: Record<string, unknown>,
	connections: Record<string, unknown>,
) {
	const identities = new Map<string, string>();
	for (const name of Object.keys(setups)) {
		const setup = requireOwnObject(
			setups,
			name,
			"sync setup",
		) as unknown as SyncSetupSettings;
		const connection = requireOwnObject(
			connections,
			setup.storage.connection,
			"storage connection",
		) as unknown as StorageConnectionSettings;
		const identity = effectiveSyncSetupRemoteIdentity(setup, connection);
		const existing = identities.get(identity);
		if (existing) {
			throw new Error(
				`Invalid pi-sync settings: sync setups “${existing}” and “${name}” use the same normalized remote location.`,
			);
		}
		identities.set(identity, name);
	}
}

export function effectiveSyncSetupRemoteIdentity(
	setup: SyncSetupSettings,
	connection: StorageConnectionSettings,
) {
	const storagePath = normalizeStoragePath(setup.storage.path);
	return JSON.stringify([
		"git",
		normalizeGitRemoteIdentity(connection.remote),
		normalizeGitBranch(setup.storage.branch),
		normalizeGitDirectory(storagePath),
	]);
}

function rejectLegacyFields(
	value: Record<string, unknown>,
	fields: readonly string[],
	context: string,
) {
	const field = fields.find((candidate) => Object.hasOwn(value, candidate));
	if (field) {
		throw new Error(
			`Invalid pi-sync settings: ${context} contains unsupported version 1/2 field “${field}”.`,
		);
	}
}

function requireNamedObjectMap(
	value: unknown,
	field: string,
	itemLabel: string,
) {
	const result = requireRecord(value, field);
	for (const name of Object.keys(result)) validateConfigName(name, itemLabel);
	return result;
}

function requireOwnObject(
	value: Record<string, unknown>,
	key: string,
	label: string,
) {
	const item = ownObject(value, key);
	if (!item)
		throw new Error(
			`Invalid pi-sync settings: ${label} “${key}” must be an object.`,
		);
	return item;
}

function ownObject<T extends object>(
	value: Record<string, unknown>,
	key: string,
): T | undefined {
	if (!Object.hasOwn(value, key)) return undefined;
	const item = value[key];
	return item && typeof item === "object" && !Array.isArray(item)
		? (item as T)
		: undefined;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid pi-sync settings: ${field} must be an object.`);
	}
	return value as Record<string, unknown>;
}

export function validateConfigName(value: string, field: string) {
	if (
		!value.trim() ||
		value !== value.trim() ||
		value.length > 100 ||
		value === "__proto__" ||
		value === "prototype" ||
		value === "constructor" ||
		hasControlCharacter(value)
	) {
		throw new Error(`Invalid pi-sync settings: invalid ${field} name.`);
	}
}

function requiredString(value: unknown, field: string) {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		hasControlCharacter(value)
	) {
		throw new Error(
			`Invalid pi-sync settings: ${field} must be a non-empty string.`,
		);
	}
	return value.trim();
}

function requiredCanonicalReference(value: unknown, field: string) {
	const normalized = requiredString(value, field);
	if (value !== normalized) {
		throw new Error(
			`Invalid pi-sync settings: ${field} must not have surrounding whitespace.`,
		);
	}
	return normalized;
}

function optionalCanonicalReference(value: unknown, field: string) {
	const normalized = optionalString(value, field);
	if (normalized !== undefined && value !== normalized) {
		throw new Error(
			`Invalid pi-sync settings: ${field} must not have surrounding whitespace.`,
		);
	}
	return normalized;
}

function optionalString(value: unknown, field: string) {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || hasControlCharacter(value)) {
		throw new Error(`Invalid pi-sync settings: ${field} must be a string.`);
	}
	return value.trim() || undefined;
}

export function normalizeStoragePath(value: string) {
	if (value.trim() === "." || value.trim() === "./") return "./";
	const normalized = value.trim().replace(/^\/+|\/+$/gu, "");
	if (
		!normalized ||
		normalized.length > 1024 ||
		normalized.startsWith("-") ||
		normalized.includes("\\") ||
		hasControlCharacter(normalized) ||
		normalized
			.split("/")
			.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error(
			"Invalid pi-sync settings: storage.path must be a safe relative path.",
		);
	}
	return normalized;
}

export async function configuredSessionDir() {
	const settings = await readJsonIfExists<{ sessionDir?: string }>(
		path.join(agentDir(), "settings.json"),
	);
	return settings?.sessionDir ? expandHome(settings.sessionDir) : undefined;
}

export async function sessionDirForApply(
	ctx: ExtensionCommandContext | ExtensionContext,
	snapshot: Snapshot,
) {
	const contextSessionDir = sessionDirFromContext(ctx);
	const localSessionDir = await configuredSessionDir();
	if (
		contextSessionDir &&
		path.resolve(contextSessionDir) !== path.resolve(localSessionDir ?? "")
	) {
		return contextSessionDir;
	}
	return sessionDirFromSnapshot(snapshot) ?? contextSessionDir;
}

function sessionDirFromSnapshot(snapshot: Snapshot) {
	const settingsFile = snapshot.files.find(
		(file) => file.path === "settings.json",
	);
	if (!settingsFile) return undefined;
	try {
		const settings = JSON.parse(
			decodeBase64Strict(
				settingsFile.contentBase64,
				settingsFile.path,
			).toString("utf8"),
		) as { sessionDir?: string };
		return settings.sessionDir ? expandHome(settings.sessionDir) : undefined;
	} catch {
		return undefined;
	}
}

function decodeBase64Strict(value: string, filePath: string) {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
		throw new Error(`Invalid base64 content in snapshot file: ${filePath}`);
	}
	return Buffer.from(value, "base64");
}

export async function readState(profile: string): Promise<SyncState> {
	return (
		(await readJsonIfExists<SyncState>(statePath(profile))) ?? {
			version: STATE_VERSION,
			profile,
			lastFileHashes: {},
		}
	);
}

export async function writeState(profile: string, state: SyncState) {
	await writeJson(statePath(profile), state);
}

export async function readStateForConfig(
	config: AnySyncConfig,
): Promise<SyncState> {
	return (
		(await readJsonIfExists<SyncState>(statePathForConfig(config))) ?? {
			version: STATE_VERSION,
			profile: config.snapshotIdentity,
			lastFileHashes: {},
		}
	);
}

export async function writeStateForConfig(
	config: AnySyncConfig,
	state: SyncState,
) {
	await writeJson(statePathForConfig(config), state);
}

export function statePathForConfig(config: AnySyncConfig) {
	const identity = backendIdentityCoordinates(config);
	const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
	return path.join(
		stateDir(),
		"setups",
		`${config.backend.type}-${hash}.state.json`,
	);
}

function backendIdentityCoordinates(config: AnySyncConfig) {
	return JSON.stringify([
		"git",
		normalizeGitRemoteIdentity(config.backend.profile.remote),
		config.backend.destination.branch,
		config.storagePath,
	]);
}

export function agentDir() {
	return getAgentDir();
}

function expandHome(value: string) {
	return value === "~" || value.startsWith("~/")
		? path.join(os.homedir(), value.slice(2))
		: value;
}

export { stateDir } from "./state-directory.js";

export function localConfigTemplate(): PiSyncSettingsV3 {
	return {
		version: 3,
		onSwitch: DEFAULT_ON_SWITCH,
		skipSecretScan: false,
		storageConnections: {},
		syncSetups: {},
	};
}

export async function readLocalConfigDocument() {
	const document = await readMigratingLocalConfigDocument((settings) => {
		validateSettingsDocument(settings);
	});
	if (document) validateSettingsDocument(document.parsed);
	return document;
}

export async function readLocalConfigObject(): Promise<
	PiSyncSettingsV3 | undefined
> {
	return (await readLocalConfigDocument())?.parsed as
		| PiSyncSettingsV3
		| undefined;
}

let configUpdateQueue: Promise<void> = Promise.resolve();

export function updateLocalConfig(
	update: (current: PiSyncSettingsV3) => PiSyncSettingsV3,
	signal?: AbortSignal,
) {
	const operation = configUpdateQueue.then(() => {
		signal?.throwIfAborted();
		return performLocalConfigUpdate(update, signal);
	});
	configUpdateQueue = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}

async function performLocalConfigUpdate(
	update: (current: PiSyncSettingsV3) => PiSyncSettingsV3,
	signal?: AbortSignal,
) {
	return updateLocalConfigDocument(
		localConfigTemplate(),
		update,
		validateSettingsDocument,
		signal,
	);
}

export class SyncSetupReviewChangedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SyncSetupReviewChangedError";
	}
}

export async function saveNewV3Settings(
	input: {
		setupName: string;
		connectionName: string;
		connection: StorageConnectionSettings;
		setup: SyncSetupSettings;
	},
	signal?: AbortSignal,
) {
	validateConfigName(input.setupName, "sync setup");
	validateConfigName(input.connectionName, "storage connection");
	const settings: PiSyncSettingsV3 = {
		version: 3,
		activeSyncSetup: input.setupName,
		onSwitch: "ask-before-pull",
		skipSecretScan: false,
		storageConnections: {
			[input.connectionName]: structuredClone(input.connection),
		},
		syncSetups: {
			[input.setupName]: {
				...structuredClone(input.setup),
				storage: { ...input.setup.storage, connection: input.connectionName },
			},
		},
	};
	return updateLocalConfig((current) => {
		if (
			Object.keys(current.storageConnections).length ||
			Object.keys(current.syncSetups).length
		) {
			throw new Error(`Settings already exist: ${localConfigPath()}`);
		}
		return { ...current, ...settings };
	}, signal);
}

export async function addStorageConnection(
	name: string,
	connection: StorageConnectionSettings,
	signal?: AbortSignal,
) {
	validateConfigName(name, "storage connection");
	await updateSettings((settings) => {
		if (Object.hasOwn(settings.storageConnections, name)) {
			throw new Error(`Storage connection already exists: ${name}`);
		}
		return {
			...settings,
			storageConnections: {
				...settings.storageConnections,
				[name]: structuredClone(connection),
			},
		};
	}, signal);
}

export async function updateStorageConnection(
	name: string,
	update: (connection: StorageConnectionSettings) => StorageConnectionSettings,
	expectedSetups?: readonly string[],
	signal?: AbortSignal,
) {
	validateConfigName(name, "storage connection");
	await updateSettings((settings) => {
		const connection = settings.storageConnections[name];
		if (!connection) throw new Error(`Storage connection not found: ${name}`);
		const currentSetups = referencingSetupNames(settings.syncSetups, name);
		if (expectedSetups && !sameNames(currentSetups, expectedSetups)) {
			throw new Error(
				`Storage connection “${name}” usage changed while it was open; reopen it and review the affected sync setups.`,
			);
		}
		const nextConnection = update(structuredClone(connection));
		const nextConnections = {
			...settings.storageConnections,
			[name]: nextConnection,
		};
		assertUniqueLocations(settings.syncSetups, nextConnections);
		return { ...settings, storageConnections: nextConnections };
	}, signal);
}

export async function addSyncSetup(
	name: string,
	setup: SyncSetupSettings,
	signal?: AbortSignal,
) {
	validateConfigName(name, "sync setup");
	await updateSettings((settings) => {
		if (Object.hasOwn(settings.syncSetups, name))
			throw new Error(`Sync setup already exists: ${name}`);
		if (!Object.hasOwn(settings.storageConnections, setup.storage.connection)) {
			throw new Error(
				`Storage connection not found: ${setup.storage.connection}`,
			);
		}
		const nextSetups = {
			...settings.syncSetups,
			[name]: structuredClone(setup),
		};
		assertUniqueLocations(nextSetups, settings.storageConnections);
		return {
			...settings,
			syncSetups: nextSetups,
			...(settings.activeSyncSetup ? {} : { activeSyncSetup: name }),
		};
	}, signal);
}

export async function updateSyncSetup(
	name: string,
	update: (setup: SyncSetupSettings) => SyncSetupSettings,
	options: {
		expectedStorage?: SyncSetupStorageReview;
		expectedInclude?: readonly string[];
		signal?: AbortSignal;
	} = {},
) {
	validateConfigName(name, "sync setup");
	await updateSettings((settings) => {
		const setup = settings.syncSetups[name];
		if (!setup) throw new Error(`Sync setup not found: ${name}`);
		if (
			options.expectedInclude &&
			!sameNames(
				normalizeSyncInclude(setup.sync.include),
				options.expectedInclude,
			)
		) {
			throw new SyncSetupReviewChangedError(
				`Sync setup “${name}” included content changed while it was open; reopen it and review the current selection.`,
			);
		}
		if (options.expectedStorage) {
			const connectionName = setup.storage.connection;
			const connection = settings.storageConnections[connectionName];
			if (
				!connection ||
				!sameStorageReview(
					syncSetupStorageReview(name, setup, connectionName, connection),
					options.expectedStorage,
				)
			) {
				throw new SyncSetupReviewChangedError(
					`Sync setup “${name}” storage changed while it was open; reopen it and review the current storage location.`,
				);
			}
		}
		const nextSetup = update(structuredClone(setup));
		if (
			!Object.hasOwn(settings.storageConnections, nextSetup.storage.connection)
		) {
			throw new Error(
				`Storage connection not found: ${nextSetup.storage.connection}`,
			);
		}
		const nextSetups = { ...settings.syncSetups, [name]: nextSetup };
		assertUniqueLocations(nextSetups, settings.storageConnections);
		return { ...settings, syncSetups: nextSetups };
	}, options.signal);
}

export async function removeSyncSetup(name: string, signal?: AbortSignal) {
	validateConfigName(name, "sync setup");
	await updateSettings((settings) => {
		if (!Object.hasOwn(settings.syncSetups, name))
			throw new Error(`Sync setup not found: ${name}`);
		const isCurrent = settings.activeSyncSetup === name;
		if (isCurrent && Object.keys(settings.syncSetups).length > 1) {
			throw new Error(
				"Switch to another sync setup before removing the current setup.",
			);
		}
		const syncSetups = { ...settings.syncSetups };
		delete syncSetups[name];
		const next = { ...settings, syncSetups };
		if (isCurrent) delete next.activeSyncSetup;
		return next;
	}, signal);
}

export async function removeStorageConnection(
	name: string,
	signal?: AbortSignal,
) {
	validateConfigName(name, "storage connection");
	await updateSettings((settings) => {
		const referenced = referencingSetupNames(settings.syncSetups, name)[0];
		if (referenced) {
			throw new Error(
				`Storage connection “${name}” is used by sync setup “${referenced}”.`,
			);
		}
		if (!Object.hasOwn(settings.storageConnections, name)) {
			throw new Error(`Storage connection not found: ${name}`);
		}
		const storageConnections = { ...settings.storageConnections };
		delete storageConnections[name];
		return { ...settings, storageConnections };
	}, signal);
}

async function updateSettings(
	update: (settings: PiSyncSettingsV3) => PiSyncSettingsV3,
	signal?: AbortSignal,
) {
	return updateLocalConfig((settings) => {
		if (settings.version !== 3) {
			throw new Error(
				"Storage connections and sync setups require version 3 pi-sync settings.",
			);
		}
		return update(settings);
	}, signal);
}

function referencingSetupNames(
	setups: Record<string, SyncSetupSettings>,
	connection: string,
) {
	return Object.entries(setups)
		.filter(([, setup]) => setup.storage.connection === connection)
		.map(([name]) => name)
		.sort((left, right) => left.localeCompare(right));
}

function assertUniqueLocations(
	setups: Record<string, SyncSetupSettings>,
	connections: Record<string, StorageConnectionSettings>,
) {
	const identities = new Map<string, string>();
	for (const [name, setup] of Object.entries(setups)) {
		const connection = connections[setup.storage.connection];
		if (!connection)
			throw new Error(
				`Storage connection not found: ${setup.storage.connection}`,
			);
		const identity = effectiveSyncSetupRemoteIdentity(setup, connection);
		const previous = identities.get(identity);
		if (previous) {
			throw new Error(
				`Sync setup “${name}” duplicates the storage location of “${previous}”.`,
			);
		}
		identities.set(identity, name);
	}
}

function sameNames(left: readonly string[], right: readonly string[]) {
	return (
		left.length === right.length &&
		left.every((name, index) => name === right[index])
	);
}

function sameStorageReview(
	left: SyncSetupStorageReview,
	right: SyncSetupStorageReview,
) {
	return (
		left.connectionName === right.connectionName &&
		left.storageKind === right.storageKind &&
		left.storagePath === right.storagePath &&
		left.branch === right.branch
	);
}

export async function writeLocalConfigObject(
	value: PiSyncSettingsV3 | Record<string, unknown>,
) {
	validateSettingsDocument(value as Record<string, unknown>);
	const configPath = localConfigPath();
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	try {
		const stat = await fs.lstat(configPath);
		if (stat.isSymbolicLink())
			throw new Error(
				`Refusing to overwrite symlinked pi-sync settings: ${configPath}`,
			);
		if (!stat.isFile())
			throw new Error(`pi-sync settings are not a regular file: ${configPath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporaryPath = path.join(
		path.dirname(configPath),
		`.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
		if (process.platform !== "win32") await handle.chmod(0o600);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(temporaryPath, configPath);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function statePath(profile: string) {
	return path.join(stateDir(), `${safeName(profile)}.state.json`);
}

export function lockPath() {
	return path.join(stateDir(), "lock");
}

export async function ensureStateDir() {
	await fs.mkdir(stateDir(), { recursive: true });
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function writeJson(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(value, null, "\t")}\n`, {
		mode: 0o600,
	});
	if (process.platform !== "win32") await fs.chmod(temp, 0o600);
	await fs.rename(temp, filePath);
}

export function syncSessionsWarnings(config: { include: readonly string[] }) {
	if (!config.include.includes("sessions")) return [];
	return [
		"sessions: included; Pi session JSONL can contain prompts, tool output, file paths, images, and secrets. Sync sessions only to storage you trust.",
	];
}

export function isEnabled(
	value: boolean | string | undefined,
	defaultValue: boolean,
) {
	if (value === undefined) return defaultValue;
	if (typeof value === "boolean") return value;
	return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function isExplicitlyEnabled(value: boolean | string | undefined) {
	if (typeof value === "boolean") return value;
	return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function hasControlCharacter(value: string) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Stored settings cannot contain controls.
	return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function isMissingConfigError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.startsWith("Missing pi-sync settings.") ||
			error.message === "No sync setups are configured.")
	);
}
