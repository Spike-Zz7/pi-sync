import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizeGitBranch, normalizeGitDirectory, normalizeGitRemote } from "./git-config.js";
import { requiredInput, requiredValueInput, safeTerminalText } from "./manager-helpers.js";
import {
	addStorageConnection,
	addSyncSetup,
	saveNewV3Settings,
	updateStorageConnection,
	updateSyncSetup,
} from "./settings-management.js";
import { promptAvailableSetupStorage } from "./setup-location-ui.js";
import { DEFAULT_SYNC_INCLUDE } from "./sync-policy.js";
import type { PartialConfig } from "./types.js";

export async function showGitSetup(
	ctx: ExtensionCommandContext,
	targetName: string,
	signal?: AbortSignal,
) {
	const profileName = targetName;
	const remoteInput = await promptGitRemote(ctx, signal);
	if (!remoteInput) return false;
	const destination = await promptGitDestination(ctx, signal);
	if (!destination) return false;
	const automatic = await ctx.ui.select(
		"Automatic sync for this setup",
		["Enable automatic sync", "Keep automatic sync off", "Cancel"],
		{ signal },
	);
	throwIfAborted(signal);
	if (!automatic || automatic === "Cancel") return false;
	let remote: string | undefined;
	try {
		remote = normalizeGitRemote(remoteInput);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return false;
	}
	if (!remote) return false;
	const choice = await ctx.ui.select(
		[
			"Review Git sync setup",
			"",
			`Sync setup: ${safeTerminalText(targetName)}`,
			`Storage connection: ${safeTerminalText(profileName)} (Git)`,
			`Remote: ${safeGitRemote(remote)}`,
			`Owned branch: ${safeTerminalText(destination.branch)}`,
			`Storage location: ${safeTerminalText(destination.directory)}`,
			`Included content: ${DEFAULT_SYNC_INCLUDE.length} built-in groups · Sessions: Off`,
			`Automatic sync: ${automatic === "Enable automatic sync" ? "On" : "Off"}`,
			"Authentication: existing non-interactive Git/SSH credentials; no credentials are stored by pi-sync.",
			"The remote repository must already exist. The owned branch may be created on first push.",
		].join("\n"),
		["Save setup", "Cancel"],
		{ signal },
	);
	throwIfAborted(signal);
	if (choice !== "Save setup") return false;
	await saveNewV3Settings(
		{
			setupName: targetName,
			connectionName: profileName,
			connection: { type: "git", remote },
			setup: {
				storage: {
					connection: profileName,
					branch: destination.branch,
					path: destination.directory,
				},
				sync: {
					include: [...DEFAULT_SYNC_INCLUDE],
					automatic: automatic === "Enable automatic sync",
				},
			},
		},
		signal,
	);
	if (signal?.aborted) return true;
	ctx.ui.notify(
		`Saved Git sync setup “${safeTerminalText(targetName)}”. Run /sync doctor.`,
		"info",
	);
	return true;
}

export async function showAddGitStorageProfile(ctx: ExtensionCommandContext, signal?: AbortSignal) {
	const name = await requiredInput(ctx, "Name this Git storage connection", "git", signal);
	if (!name) return false;
	const remoteInput = await promptGitRemote(ctx, signal);
	if (!remoteInput) return false;
	let remote: string | undefined;
	try {
		remote = normalizeGitRemote(remoteInput);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return false;
	}
	if (!remote) return false;
	const choice = await ctx.ui.select(
		`Review storage connection\n\nName: ${safeTerminalText(name)}\nType: Git\nRemote: ${safeGitRemote(remote)}\nCredentials: existing Git/SSH authentication (not stored)\nAdding a connection does not contact the remote or start syncing.`,
		["Add storage connection", "Cancel"],
		{ signal },
	);
	throwIfAborted(signal);
	if (choice !== "Add storage connection") return false;
	await addStorageConnection(name, { type: "git", remote }, signal);
	if (signal?.aborted) return true;
	ctx.ui.notify(`Added storage connection “${safeTerminalText(name)}”.`, "info");
	return true;
}

export async function showEditGitStorageProfile(
	ctx: ExtensionCommandContext,
	name: string,
	profile: Record<string, unknown>,
	signal?: AbortSignal,
	affectedSetups?: string[],
) {
	const remoteInput = await promptGitRemote(
		ctx,
		signal,
		typeof profile.remote === "string" ? profile.remote : undefined,
	);
	if (!remoteInput) return false;
	let remote: string | undefined;
	try {
		remote = normalizeGitRemote(remoteInput);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return false;
	}
	if (!remote) return false;
	const choice = await ctx.ui.select(
		`Review storage connection\n\nStorage connection: ${safeTerminalText(name)}\nRemote: ${safeGitRemote(String(profile.remote ?? "missing"))} → ${safeGitRemote(remote)}\nAffected sync setups: ${affectedSetups && affectedSetups.length > 0 ? affectedSetups.map(safeTerminalText).join(", ") : "None"}\nSaving changes future storage access for every affected setup; it does not move or delete remote history.`,
		["Save storage connection", "Cancel"],
		{ signal },
	);
	throwIfAborted(signal);
	if (choice !== "Save storage connection") return false;
	await updateStorageConnection(
		name,
		(current) => {
			if (current.type !== "git") throw new Error("Storage connection type changed; reopen it.");
			return { ...current, remote };
		},
		affectedSetups,
		signal,
	);
	if (signal?.aborted) return true;
	ctx.ui.notify(`Saved storage connection “${safeTerminalText(name)}”.`, "info");
	return true;
}

export async function showAddGitTarget(
	ctx: ExtensionCommandContext,
	name: string,
	profile: string,
	signal?: AbortSignal,
) {
	const selected = await promptGitDestination(ctx, signal);
	if (!selected) return false;
	const storage = await promptAvailableSetupStorage(
		ctx,
		{ connection: profile, branch: selected.branch, path: selected.directory },
		signal,
	);
	if (!storage) return false;
	const destination = { branch: storage.branch, directory: storage.path };
	const preset = await ctx.ui.select(
		"Choose included content",
		["Recommended Pi settings", "Minimal settings", "Cancel"],
		{ signal },
	);
	throwIfAborted(signal);
	if (!preset || preset === "Cancel") return false;
	const syncFiles =
		preset === "Minimal settings" ? ["settings.json", "AGENTS.md"] : [...DEFAULT_SYNC_INCLUDE];
	const automatic = await ctx.ui.select(
		"Automatic sync for this setup",
		["Enable automatic sync", "Keep automatic sync off", "Cancel"],
		{ signal },
	);
	throwIfAborted(signal);
	if (!automatic || automatic === "Cancel") return false;
	const choice = await ctx.ui.select(
		`Review Git sync setup\n\nSync setup: ${safeTerminalText(name)}\nStorage connection: ${safeTerminalText(profile)}\nOwned branch: ${safeTerminalText(destination.branch)}\nStorage location: ${safeTerminalText(destination.directory)}\nIncluded content: ${syncFiles.length} built-in groups · Sessions: Off\nAutomatic sync: ${automatic === "Enable automatic sync" ? "On" : "Off"}`,
		["Add sync setup", "Cancel"],
		{ signal },
	);
	throwIfAborted(signal);
	if (choice !== "Add sync setup") return false;
	await addSyncSetup(
		name,
		{
			storage: {
				connection: profile,
				branch: destination.branch,
				path: destination.directory,
			},
			sync: {
				include: syncFiles,
				automatic: automatic === "Enable automatic sync",
			},
		},
		signal,
	);
	if (signal?.aborted) return true;
	ctx.ui.notify(`Added sync setup “${safeTerminalText(name)}”.`, "info");
	return true;
}

export async function showEditGitTarget(
	ctx: ExtensionCommandContext,
	partial: PartialConfig,
	signal?: AbortSignal,
) {
	const targetName = partial.setupName;
	const destination = await promptGitDestination(ctx, signal, partial);
	if (!destination) return false;
	if (destination.directory !== partial.storagePath && destination.branch === partial.branch) {
		ctx.ui.notify(
			"Changing a Git storage path requires a new Git branch so the existing branch remains readable.",
			"warning",
		);
		return false;
	}
	const choice = await ctx.ui.select(
		`Review sync setup “${safeTerminalText(targetName)}”\n\nBranch: ${safeTerminalText(partial.branch ?? "pi-sync")} → ${safeTerminalText(destination.branch)}\nStorage path: ${safeTerminalText(partial.storagePath)} → ${safeTerminalText(destination.directory)}\nSaving changes the future storage location only; it does not move or delete remote history.`,
		["Save sync setup", "Cancel"],
		{ signal },
	);
	throwIfAborted(signal);
	if (choice !== "Save sync setup") return false;
	await updateSyncSetup(
		targetName,
		(setup) => {
			if (typeof setup.storage.branch !== "string") {
				throw new Error("Sync setup storage type changed; reopen it.");
			}
			return {
				...setup,
				storage: {
					...setup.storage,
					branch: destination.branch,
					path: destination.directory,
				},
			};
		},
		{ expectedStorage: partial, signal },
	);
	if (signal?.aborted) return true;
	ctx.ui.notify(`Saved sync setup “${safeTerminalText(targetName)}”.`, "info");
	return true;
}

async function promptGitRemote(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
	current?: string,
) {
	const title =
		"Git remote URL (SSH or HTTPS)\n\nUse an existing private repository with Git/SSH authentication already configured.";
	return current
		? requiredInput(ctx, title, current, signal)
		: requiredValueInput(
				ctx,
				title,
				"git@github.com:owner/private-pi-sync.git (SSH) or https://github.com/owner/private-pi-sync.git (HTTPS)",
				signal,
			);
}

async function promptGitDestination(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
	current: Partial<PartialConfig> = {},
) {
	const branchInput = await requiredInput(
		ctx,
		"Git branch for sync snapshots\n\npi-sync manages this entire branch, not your local working branch.\nUse a new branch or one already used by pi-sync; unrelated content is rejected.",
		current.branch ?? "main",
		signal,
	);
	if (!branchInput) return undefined;
	const pathInput = await requiredInput(
		ctx,
		"Git storage path\n\nRelative to the repository root, not your local filesystem.\n./ stores manifest.json and files/ at the repository root.",
		current.storagePath ?? "./",
		signal,
	);
	if (!pathInput) return undefined;
	try {
		const branch = normalizeGitBranch(branchInput);
		const directory = normalizeGitDirectory(pathInput);
		return { branch, directory };
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
}

function throwIfAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}

function safeGitRemote(remote: string) {
	try {
		const url = new URL(remote);
		return safeTerminalText(`${url.protocol}//${url.host}${url.pathname}`);
	} catch {
		return safeTerminalText(remote);
	}
}
