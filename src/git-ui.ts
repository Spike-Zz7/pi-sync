import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
	addStorageConnection,
	addSyncSetup,
	effectiveSyncSetupRemoteIdentity,
	readLocalConfigObject,
	removeStorageConnection,
	saveNewV3Settings,
	updateStorageConnection,
	updateSyncSetup,
	validateConfigName,
} from "./config.js";
import {
	normalizeGitBranch,
	normalizeGitDirectory,
	normalizeGitRemote,
} from "./git-config.js";
import {
	errorMessage,
	ownRecord,
	requiredInput,
	requiredValueInput,
	safeTerminalText,
} from "./manager-helpers.js";
import {
	DEFAULT_SYNC_INCLUDE,
	formatIncludedContentSummary,
} from "./sync-policy.js";
import type {
	PartialConfig,
	StorageConnectionSettings,
	SyncSetupSettings,
} from "./types.js";

export async function showGitSetup(
	ctx: ExtensionCommandContext,
	targetName: string,
	signal?: AbortSignal,
) {
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
		ctx.ui.notify(
			error instanceof Error ? error.message : String(error),
			"error",
		);
		return false;
	}
	if (!remote) return false;
	const choice = await ctx.ui.select(
		[
			"Review Git sync setup",
			"",
			`Sync setup: ${safeTerminalText(targetName)}`,
			`Storage connection: ${safeTerminalText(targetName)} (Git)`,
			`Remote: ${safeGitRemote(remote)}`,
			`Owned branch: ${safeTerminalText(destination.branch)}`,
			`Storage location: ${safeTerminalText(destination.directory)}`,
			`Included content: ${formatIncludedContentSummary(DEFAULT_SYNC_INCLUDE)}`,
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
			connectionName: targetName,
			connection: { type: "git", remote },
			setup: {
				storage: {
					connection: targetName,
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

export async function showAddGitStorageProfile(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
) {
	const name = await requiredInput(
		ctx,
		"Name this Git storage connection",
		"git",
		signal,
	);
	if (!name) return false;
	const remoteInput = await promptGitRemote(ctx, signal);
	if (!remoteInput) return false;
	let remote: string | undefined;
	try {
		remote = normalizeGitRemote(remoteInput);
	} catch (error) {
		ctx.ui.notify(
			error instanceof Error ? error.message : String(error),
			"error",
		);
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
	ctx.ui.notify(
		`Added storage connection “${safeTerminalText(name)}”.`,
		"info",
	);
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
		ctx.ui.notify(
			error instanceof Error ? error.message : String(error),
			"error",
		);
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
			if (current.type !== "git")
				throw new Error("Storage connection type changed; reopen it.");
			return { ...current, remote };
		},
		affectedSetups,
		signal,
	);
	if (signal?.aborted) return true;
	ctx.ui.notify(
		`Saved storage connection “${safeTerminalText(name)}”.`,
		"info",
	);
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
		preset === "Minimal settings"
			? ["settings.json", "AGENTS.md"]
			: [...DEFAULT_SYNC_INCLUDE];
	const automatic = await ctx.ui.select(
		"Automatic sync for this setup",
		["Enable automatic sync", "Keep automatic sync off", "Cancel"],
		{ signal },
	);
	throwIfAborted(signal);
	if (!automatic || automatic === "Cancel") return false;
	const choice = await ctx.ui.select(
		`Review Git sync setup\n\nSync setup: ${safeTerminalText(name)}\nStorage connection: ${safeTerminalText(profile)}\nOwned branch: ${safeTerminalText(destination.branch)}\nStorage location: ${safeTerminalText(destination.directory)}\nIncluded content: ${formatIncludedContentSummary(syncFiles)}\nAutomatic sync: ${automatic === "Enable automatic sync" ? "On" : "Off"}`,
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
	if (
		destination.directory !== partial.storagePath &&
		destination.branch === partial.branch
	) {
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
		ctx.ui.notify(
			error instanceof Error ? error.message : String(error),
			"error",
		);
		return undefined;
	}
}

function throwIfAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}

export function safeGitRemote(remote: string) {
	try {
		const url = new URL(remote);
		return safeTerminalText(`${url.protocol}//${url.host}${url.pathname}`);
	} catch {
		return safeTerminalText(remote);
	}
}

export async function promptInitialSetupName(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
) {
	while (!signal?.aborted) {
		const hint = "For example: home or work. Leave blank for default.";
		// Pi styles the whole input title as accent; give only the guidance a muted role.
		const guidance = ctx.mode === "tui" ? ctx.ui.theme.fg("muted", hint) : hint;
		// This compact prompt owns its default hint; the general helper would repeat it.
		const value = await ctx.ui.input(
			`Sync setup name\n${guidance}`,
			undefined,
			{ signal },
		);
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new DOMException("The operation was aborted", "AbortError");
		}
		if (value === undefined) return undefined;
		const name = value.trim() || "default";
		if (name.includes("<") || name.includes(">")) return undefined;
		try {
			validateConfigName(name, "sync setup");
			return name;
		} catch (error) {
			ctx.ui.notify(
				`This name cannot be used for the sync setup. ${safeTerminalText(errorMessage(error))} Enter another name (for example, default).`,
				"warning",
			);
		}
	}
	return undefined;
}

/** Early UI check only; the settings writer still validates uniqueness under its lock. */
export async function promptAvailableSetupStorage<
	T extends SyncSetupSettings["storage"],
>(
	ctx: ExtensionCommandContext,
	initial: T,
	signal?: AbortSignal,
): Promise<T | undefined> {
	let storage = initial;
	while (!signal?.aborted) {
		const settings = await readLocalConfigObject();
		if (signal?.aborted) return undefined;
		const connection = settings?.storageConnections[storage.connection];
		if (!settings || !connection)
			throw new Error("Storage connection changed; reopen setup.");
		const identity = setupPublicationIdentity(storage, connection);
		const occupied = Object.entries(settings.syncSetups).find(
			([, setup]) =>
				setupPublicationIdentity(
					setup.storage,
					settings.storageConnections[setup.storage.connection],
				) === identity,
		);
		if (!occupied) return storage;
		const message = `Git branch is already used by “${safeTerminalText(occupied[0])}”. Use a different branch; pi-sync owns the entire branch.`;
		ctx.ui.notify(message, "warning");
		const title = `Git branch for the new setup\n\n${message}`;
		const example = "pi-sync/work";
		const value = await requiredValueInput(ctx, title, example, signal);
		if (signal?.aborted || value === undefined) return undefined;
		try {
			storage = { ...storage, branch: normalizeGitBranch(value) };
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

export async function showStorageConnections(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
) {
	let selectedName: string | undefined;
	const nameById = new Map<string, string>();
	type Screen = "list" | "detail";
	type Action = "add" | "select" | "edit" | "remove" | "back";
	const menu = defineMenu<
		Awaited<ReturnType<typeof loadStorageMenuState>>,
		Screen,
		Action,
		ExtensionCommandContext
	>({
		start: "list",
		screens: {
			list: ({ state }) => {
				nameById.clear();
				const names = Object.keys(state.profiles).sort((a, b) =>
					a.localeCompare(b),
				);
				return {
					kind: "actions",
					title: "Storage connections",
					lines: state.version3
						? []
						: [
								"Create version 3 settings before managing storage connections.",
							],
					items: state.version3
						? [
								{
									id: "add",
									label: "Add storage connection",
									action: "add" as const,
								},
								...names.map((name, index) => {
									const id = `connection:${index}`;
									nameById.set(id, name);
									return {
										id,
										label: safeTerminalText(name),
										action: "select" as const,
									};
								}),
							]
						: [],
					hint: "back",
				};
			},
			detail: ({ state }) => ({
				kind: "actions",
				title: state.selected
					? `Storage connection “${safeTerminalText(state.selected.name)}”`
					: "Storage connection",
				lines: state.selected?.lines ?? [
					"This storage connection no longer exists.",
				],
				items: state.selected
					? [
							{ id: "edit", label: "Edit storage connection…", action: "edit" },
							...(state.selected.usedBy.length === 0
								? [
										{
											id: "remove",
											label: "Remove storage connection…",
											action: "remove" as const,
										},
									]
								: []),
							{ id: "back", label: "Back", action: "back" },
						]
					: [{ id: "back", label: "Back", action: "back" }],
				hint: "back",
			}),
		},
		actions: {
			add: async () => {
				await showAddStorageConnection(ctx, signal);
				return { kind: "stay" };
			},
			select: async ({ itemId }) => {
				selectedName = nameById.get(itemId);
				return selectedName
					? { kind: "to", screen: "detail" }
					: { kind: "rejected" };
			},
			edit: async ({ state }) => {
				if (!state.selected) return { kind: "rejected" };
				await showEditGitStorageProfile(
					ctx,
					state.selected.name,
					state.selected.profile,
					signal,
					state.selected.usedBy,
				);
				return { kind: "stay" };
			},
			remove: async ({ state }) => {
				if (!state.selected) return { kind: "rejected" };
				const confirmed = await ctx.ui.confirm(
					"Remove storage connection?",
					`Remove “${safeTerminalText(state.selected.name)}”?`,
					{ signal },
				);
				if (confirmed)
					await removeStorageConnection(state.selected.name, signal);
				return { kind: "back" };
			},
			back: async () => {
				selectedName = undefined;
				return { kind: "back" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => loadStorageMenuState(selectedName, signal),
		signal,
		isCurrent: () => !signal?.aborted,
	});
}

async function loadStorageMenuState(
	selectedName: string | undefined,
	signal?: AbortSignal,
) {
	const raw = await readLocalConfigObject();
	if (signal?.aborted) throw signal.reason;
	const profiles = ownRecord(raw?.storageConnections) ?? {};
	const profile = selectedName ? ownRecord(profiles[selectedName]) : undefined;
	if (!selectedName || !profile) {
		return { version3: raw?.version === 3, profiles, selected: undefined };
	}
	const usedBy = Object.entries(ownRecord(raw?.syncSetups) ?? {})
		.filter(
			([, value]) =>
				ownRecord(ownRecord(value)?.storage)?.connection === selectedName,
		)
		.map(([name]) => name)
		.sort();
	return {
		version3: raw?.version === 3,
		profiles,
		selected: {
			name: selectedName,
			profile,
			usedBy,
			lines: [
				"Type: Git",
				`Endpoint: ${safeGitRemote(String(profile.remote ?? ""))}`,
				"Credentials: Git credential helper or SSH configuration",
				`Used by: ${usedBy.length > 0 ? usedBy.map(safeTerminalText).join(", ") : "No sync setups"}`,
				...(usedBy.length > 0
					? ["Remove unavailable: edit or remove the listed sync setups first."]
					: []),
			],
		},
	};
}

export async function showAddStorageConnection(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
) {
	return showAddGitStorageProfile(ctx, signal);
}
