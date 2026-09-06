import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { loadConfig, readLocalConfigObject } from "./config.js";
import { errorMessage, ownRecord, safeTerminalText } from "./manager-helpers.js";
import { syncIncludeSelection } from "./sync-policy.js";

export async function countValidSyncSetups(
	setups: Record<string, unknown> | undefined,
	signal?: AbortSignal,
) {
	let count = 0;
	for (const name of Object.keys(setups ?? {})) {
		throwIfAborted(signal);
		let valid = false;
		try {
			await loadConfig(name);
			valid = true;
		} catch {
			// Invalid setups stay visible in management but are not switchable.
		}
		throwIfAborted(signal);
		if (valid) count += 1;
	}
	return count;
}

function throwIfAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}

type SyncSetupActions = {
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
	type Action = "add" | "select" | "make-current" | "edit" | "remove" | "back";
	const menu = defineMenu<SetupMenuState, Screen, Action, ExtensionCommandContext>({
		start: "list",
		screens: {
			list: ({ state }) => {
				nameById.clear();
				const names = Object.keys(state.setups).sort((left, right) => left.localeCompare(right));
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
							`Sync setup was not added: ${menuErrorMessage(error)} Retry from Add sync setup.`,
							"error",
						);
					}
				}
				return { kind: "stay" };
			},
			select: async ({ itemId }) => {
				selectedName = nameById.get(itemId);
				return selectedName ? { kind: "to", screen: "detail" } : { kind: "rejected" };
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
	throwIfAborted(signal);
	const setups = ownRecord(raw?.syncSetups) ?? {};
	const active = typeof raw?.activeSyncSetup === "string" ? raw.activeSyncSetup : undefined;
	if (!selectedName || !ownRecord(setups[selectedName])) return { setups, active };
	const setupCount = Object.keys(setups).length;
	const isCurrent = selectedName === active;
	let detail: string[];
	let valid = true;
	try {
		const config = await loadConfig(selectedName);
		throwIfAborted(signal);
		const selection = syncIncludeSelection(config.include);
		detail = [
			`Status: ${isCurrent ? "Current" : "Not current"}`,
			`Storage connection: ${safeTerminalText(config.connectionName)}`,
			`Endpoint: ${storageEndpoint(config)}`,
			`Storage location: ${storageLocation(config)}`,
			`Included content: ${selection.builtIns.length} built-in groups · ${selection.custom.length} extra paths`,
			`Sessions: ${selection.sessions ? "On — privacy-sensitive" : "Off"}`,
			`Automatic sync: ${config.automatic ? "On" : "Off"}`,
		];
	} catch (error) {
		valid = false;
		detail = [
			`Status: Invalid${isCurrent ? " current setup" : ""}`,
			`Reason: ${menuErrorMessage(error)}`,
			"Make current and sync are unavailable until this setup is repaired.",
		];
	}
	const removeUnavailable = isCurrent && setupCount > 1;
	if (removeUnavailable) detail.push("Remove unavailable: switch to another setup first.");
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
		`Sync setup “${safeTerminalText(name)}” was not changed: ${menuErrorMessage(error)} Reopen it and retry.`,
		"error",
	);
}

function menuErrorMessage(error: unknown) {
	return safeTerminalText(errorMessage(error));
}

function storageEndpoint(config: Awaited<ReturnType<typeof loadConfig>>) {
	switch (config.backend.type) {
		case "s3":
			return safeTerminalText(config.backend.profile.endpoint);
		case "git":
			return safeTerminalText(config.backend.profile.remote);
		case "webdav":
			return safeTerminalText(config.backend.profile.url);
	}
}

function storageLocation(config: Awaited<ReturnType<typeof loadConfig>>) {
	switch (config.backend.type) {
		case "s3":
			return safeTerminalText(`${config.backend.destination.bucket}/${config.storagePath}`);
		case "git":
			return safeTerminalText(`Git · ${config.backend.destination.branch}:${config.storagePath}`);
		case "webdav":
			return safeTerminalText(`WebDAV · ${config.storagePath}`);
	}
}
