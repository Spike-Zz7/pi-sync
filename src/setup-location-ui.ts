import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	effectiveSyncSetupRemoteIdentity,
	isCloudflareR2Endpoint,
	normalizeStoragePath,
	readLocalConfigObject,
} from "./config.js";
import { normalizeGitBranch } from "./git-config.js";
import {
	errorMessage,
	ownRecord,
	promptTextInput,
	requiredExistingBucket,
	requiredInput,
	requiredValueInput,
	safeTerminalText,
} from "./manager-helpers.js";
import type { StorageConnectionSettings, SyncSetupSettings } from "./types.js";

interface ChosenRemoteLocation {
	connectionName: string;
	bucket: string;
	path: string;
}

export async function chooseInitialRemoteLocation(
	ctx: ExtensionCommandContext,
	preset: string,
	setupName: string,
	signal?: AbortSignal,
): Promise<ChosenRemoteLocation | undefined> {
	const connectionName = setupName;
	const suggested = {
		connectionName,
		bucket: "pi-sync",
		path: "./",
	};
	if (preset === "Cloudflare R2") {
		const choice = await ctx.ui.select(
			[
				"Choose storage location",
				"",
				`Suggested storage connection: ${safeTerminalText(connectionName)}`,
				`Suggested bucket: ${suggested.bucket}`,
				`Remote path: ${safeTerminalText(suggested.path)}`,
				"Bucket must already exist. pi-sync will not create it.",
			].join("\n"),
			["Use suggested location (recommended)", "Customize remote location", "Cancel"],
			{ signal },
		);
		if (signal?.aborted || !choice || choice === "Cancel") return undefined;
		if (choice === "Use suggested location (recommended)") return suggested;
		return chooseCustomRemoteLocation(ctx, connectionName, signal);
	}

	const choice = await ctx.ui.select(
		[
			"Choose storage location",
			"",
			`Suggested storage connection: ${safeTerminalText(connectionName)}`,
			`Suggested path: ${safeTerminalText(suggested.path)}`,
			"S3 bucket names may need to be globally unique and the bucket must already exist.",
		].join("\n"),
		[
			"Use existing bucket with suggested path (recommended)",
			"Customize remote location",
			"Cancel",
		],
		{ signal },
	);
	if (signal?.aborted || !choice || choice === "Cancel") return undefined;
	if (choice === "Customize remote location") {
		return chooseCustomRemoteLocation(ctx, connectionName, signal);
	}
	const bucket = await requiredExistingBucket(ctx, "pi-sync-your-name", signal);
	return bucket ? { ...suggested, bucket } : undefined;
}

export async function chooseAdditionalRemoteLocation(
	ctx: ExtensionCommandContext,
	settings: Record<string, unknown>,
	connectionName: string,
	setupName: string,
	signal?: AbortSignal,
): Promise<Omit<ChosenRemoteLocation, "connectionName"> | undefined> {
	const setups = ownRecord(settings.syncSetups) ?? {};
	const currentSetup =
		typeof settings.activeSyncSetup === "string" ? settings.activeSyncSetup : undefined;
	const candidates = Object.entries(setups)
		.map(([name, value]) => ({ name, storage: ownRecord(ownRecord(value)?.storage) }))
		.filter(
			(item): item is { name: string; storage: Record<string, unknown> } =>
				item.storage?.connection === connectionName && typeof item.storage.bucket === "string",
		);
	const source =
		candidates.find((item) => item.name === currentSetup) ??
		candidates.sort((left, right) => left.name.localeCompare(right.name))[0];
	if (source) {
		const suggestedPath = "./";
		const sameBucketLabel = `Same bucket as “${safeTerminalText(source.name)}”`;
		const choice = await ctx.ui.select(
			[
				`Storage location for “${safeTerminalText(setupName)}”`,
				"",
				`Existing bucket: ${safeTerminalText(String(source.storage.bucket))}`,
				`Remote path: ${safeTerminalText(suggestedPath)}`,
				"./ uses the bucket root. Use a different path or bucket for independent setups.",
			].join("\n"),
			[sameBucketLabel, "Use a different bucket", "Customize remote location", "Cancel"],
			{ signal },
		);
		if (signal?.aborted || !choice || choice === "Cancel") return undefined;
		if (choice === sameBucketLabel) {
			return { bucket: String(source.storage.bucket), path: suggestedPath };
		}
		if (choice === "Use a different bucket") {
			const bucket = await requiredExistingBucket(ctx, "pi-sync", signal);
			return bucket ? { bucket, path: "./" } : undefined;
		}
		const custom = await chooseCustomRemoteLocation(ctx, connectionName, signal);
		return custom ? { bucket: custom.bucket, path: custom.path } : undefined;
	}

	const connectionSettings = ownRecord(ownRecord(settings.storageConnections)?.[connectionName]);
	const isR2 = isCloudflareR2Endpoint(String(connectionSettings?.endpoint ?? ""));
	const suggestedPath = "./";
	const suggestedLabel = isR2
		? "Use suggested location (recommended)"
		: "Use existing bucket with suggested path (recommended)";
	const choice = await ctx.ui.select(
		`Storage location for “${safeTerminalText(setupName)}”\n\nSuggested path: ${safeTerminalText(suggestedPath)}`,
		[suggestedLabel, "Customize remote location", "Cancel"],
		{ signal },
	);
	if (signal?.aborted || !choice || choice === "Cancel") return undefined;
	if (choice === "Customize remote location") {
		const custom = await chooseCustomRemoteLocation(ctx, connectionName, signal);
		return custom ? { bucket: custom.bucket, path: custom.path } : undefined;
	}
	if (isR2) return { bucket: "pi-sync", path: suggestedPath };
	const bucket = await requiredExistingBucket(ctx, "pi-sync-your-name", signal);
	return bucket ? { bucket, path: suggestedPath } : undefined;
}

async function chooseCustomRemoteLocation(
	ctx: ExtensionCommandContext,
	connectionName: string,
	signal?: AbortSignal,
): Promise<ChosenRemoteLocation | undefined> {
	const bucket = await requiredExistingBucket(ctx, "pi-sync", signal);
	if (!bucket) return undefined;
	const storagePath = await requiredInput(
		ctx,
		"Storage path\n\nObject-key prefix inside the bucket, not your local filesystem.\n./ uses the bucket root. Use different prefixes for independent setups.",
		"./",
		signal,
	);
	if (!storagePath) return undefined;
	return { connectionName, bucket, path: normalizeStoragePath(storagePath) };
}

/** Early UI check only; the settings writer still validates uniqueness under its lock. */
export async function promptAvailableSetupStorage<T extends SyncSetupSettings["storage"]>(
	ctx: ExtensionCommandContext,
	initial: T,
	signal?: AbortSignal,
): Promise<T | undefined> {
	let storage = initial;
	while (!signal?.aborted) {
		const settings = await readLocalConfigObject();
		if (signal?.aborted) return undefined;
		const connection = settings?.storageConnections[storage.connection];
		if (!settings || !connection) throw new Error("Storage connection changed; reopen setup.");
		const identity = setupPublicationIdentity(storage, connection);
		const occupied = Object.entries(settings.syncSetups).find(
			([, setup]) =>
				setupPublicationIdentity(
					setup.storage,
					settings.storageConnections[setup.storage.connection],
				) === identity,
		);
		if (!occupied) return storage;
		const git = connection.type === "git";
		const message = `${git ? "Git branch" : "Storage location"} is already used by “${safeTerminalText(occupied[0])}”. ${git ? "Use a different branch; pi-sync owns the entire branch." : "Enter a different storage path, or cancel to choose another connection or bucket."}`;
		ctx.ui.notify(message, "warning");
		const title = `${git ? "Git branch for the new setup" : "Storage path for the new setup"}\n\n${message}`;
		const example = git ? "pi-sync/work" : "backups/work";
		const value =
			connection.type === "webdav"
				? await promptTextInput(ctx, title, { example }, signal)
				: await requiredValueInput(ctx, title, example, signal);
		if (signal?.aborted || value === undefined) return undefined;
		try {
			storage = git
				? { ...storage, branch: normalizeGitBranch(value) }
				: { ...storage, path: normalizeStoragePath(value) };
		} catch (error) {
			ctx.ui.notify(safeTerminalText(errorMessage(error)), "warning");
		}
	}
	return undefined;
}

function setupPublicationIdentity(
	storage: SyncSetupSettings["storage"],
	connection: StorageConnectionSettings,
) {
	// Git publications own a complete branch tree; changing only its directory is not isolation.
	return effectiveSyncSetupRemoteIdentity(
		{
			storage: connection.type === "git" ? { ...storage, path: "./" } : storage,
			sync: { include: [], automatic: false },
		},
		connection,
	);
}
