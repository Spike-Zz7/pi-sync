import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { runConfirmation } from "@narumitw/pi-tui-kit";
import type { RunRoute } from "./cancellable-operation.js";
import {
	activeLocalConfigPath,
	loadConfig,
	readLocalConfigObject,
	readStateForConfig,
} from "./config.js";
import {
	inspectLock,
	isLockGuardHeld,
	isStaleLock,
	type LockInspection,
} from "./lock.js";
import {
	errorMessage,
	ownRecord,
	safeTerminalText,
} from "./manager-helpers.js";
import {
	type SyncAttentionState,
	syncAttentionMatchesConfig,
} from "./sync-attention.js";
import {
	compareSyncInclude,
	formatIncludedContentSummary,
} from "./sync-policy.js";
import type { AnySyncConfig, LockFile } from "./types.js";

export async function countValidSyncSetups(
	setups: Record<string, unknown> | undefined,
	signal?: AbortSignal,
) {
	let count = 0;
	for (const name of Object.keys(setups ?? {})) {
		if (signal?.aborted) throw signal.reason;
		let valid = false;
		try {
			await loadConfig(name);
			valid = true;
		} catch {
			// Invalid setups stay visible in management but are not switchable.
		}
		if (signal?.aborted) throw signal.reason;
		if (valid) count += 1;
	}
	return count;
}

export type OperationAvailability =
	| { kind: "free" }
	| { kind: "live"; lock: LockFile }
	| { kind: "busy"; lock?: LockFile; metadata: LockInspection["status"] }
	| { kind: "recoverable-stale"; lock: LockFile }
	| { kind: "recoverable-unreadable" }
	| { kind: "inspection-error"; message: string };

export interface OperationInspectionDependencies {
	inspectMetadata(): Promise<LockInspection>;
	inspectGuard(): Promise<boolean>;
}

const DEFAULT_INSPECTION_DEPENDENCIES: OperationInspectionDependencies = {
	inspectMetadata: inspectLock,
	inspectGuard: isLockGuardHeld,
};

export async function inspectOperationAvailability(
	dependencies: OperationInspectionDependencies = DEFAULT_INSPECTION_DEPENDENCIES,
): Promise<OperationAvailability> {
	try {
		const metadata = await dependencies.inspectMetadata();
		const guardHeld = await dependencies.inspectGuard();
		return classifyOperationAvailability(metadata, guardHeld);
	} catch (error) {
		return { kind: "inspection-error", message: errorMessage(error) };
	}
}

export function classifyOperationAvailability(
	metadata: LockInspection,
	guardHeld: boolean,
): OperationAvailability {
	if (metadata.status === "valid" && !isStaleLock(metadata.lock)) {
		return { kind: "live", lock: metadata.lock };
	}
	if (guardHeld) {
		return {
			kind: "busy",
			metadata: metadata.status,
			...(metadata.status === "valid" ? { lock: metadata.lock } : {}),
		};
	}
	if (metadata.status === "valid") {
		return { kind: "recoverable-stale", lock: metadata.lock };
	}
	if (metadata.status === "unreadable")
		return { kind: "recoverable-unreadable" };
	return { kind: "free" };
}

export function operationBlocksChanges(availability: OperationAvailability) {
	return availability.kind !== "free";
}

export function operationCanRecover(availability: OperationAvailability) {
	return (
		availability.kind === "recoverable-stale" ||
		availability.kind === "recoverable-unreadable"
	);
}

export type RecoveryDisposition = "restored" | "stay" | "close";

export async function recoverSyncAccess(
	ctx: ExtensionCommandContext,
	manager: ManagerDescription,
	runRoute: RunRoute,
	sessionSignal: AbortSignal | undefined,
	actionSignal: AbortSignal,
): Promise<RecoveryDisposition> {
	const operation = manager.operation;
	if (!operation || !operationCanRecover(operation)) {
		ctx.ui.notify(
			"Operation status changed. Refresh the manager before retrying recovery.",
			"warning",
		);
		return "stay";
	}
	const signal = sessionSignal
		? AbortSignal.any([sessionSignal, actionSignal])
		: actionSignal;
	if (signal.aborted) return "close";
	const unreadable = operation.kind === "recoverable-unreadable";
	const details = unreadable
		? "Pi-sync cannot verify who owns the unreadable lock. Close other Pi sessions that may be syncing before continuing."
		: `The recorded ${safeTerminalText(operation.lock.command)} operation (pid ${operation.lock.pid}) appears to have stopped. Close other Pi sessions that may still be syncing before continuing.`;
	const confirmation = await runConfirmation(ctx, {
		title: "Restore sync access?",
		message: [
			details,
			"",
			"This removes only the local operation lock.",
			"It does not change settings, local files, sync state, or remote data.",
		].join("\n"),
		confirmLabel: "Remove local lock and continue",
		cancelLabel: "Cancel",
		signal,
		isCurrent: () => !signal.aborted,
		onError: (_currentCtx, error) => {
			ctx.ui.notify(
				`Recovery confirmation failed: ${safeTerminalText(errorMessage(error))}`,
				"error",
			);
		},
	});
	if (confirmation.kind === "stale") return "close";
	if (confirmation.kind === "closed") {
		if (confirmation.reason === "close") return "close";
		if (!signal.aborted) {
			ctx.ui.notify(
				"Recovery cancelled; the local operation lock was not changed.",
				"info",
			);
		}
		return "stay";
	}
	if (confirmation.kind !== "confirmed") return "stay";
	if (signal.aborted) return "close";
	await runRoute(unreadable ? "unlock --stale" : "unlock", signal);
	if (signal.aborted) return "close";
	const latest = await inspectOperationAvailability();
	if (signal.aborted) return "close";
	return latest.kind === "free" ? "restored" : "stay";
}

export const MAIN_MENU_ACTIONS = [
	"Sync now (recommended)",
	"Switch sync setup",
	"Status & changes",
	"Settings",
	"More…",
] as const;

export interface ManagerDescription {
	title: string;
	actions: string[];
	operation?: OperationAvailability;
	attention?: SyncAttentionState;
	attentionBlocksSync?: boolean;
	attentionReviewDisabled?: boolean;
}

export async function describeManagerState(
	signal?: AbortSignal,
	attention?: SyncAttentionState,
	inspectOperation: () => Promise<OperationAvailability> = inspectOperationAvailability,
): Promise<ManagerDescription> {
	let raw: Record<string, unknown> | undefined;
	try {
		raw = await readLocalConfigObject();
	} catch (error) {
		return {
			title: [
				"Manage sync",
				"",
				"Settings file needs repair. Automatic sync and settings writes are paused.",
				`Error: ${safeTerminalText(errorMessage(error))}`,
				`File: ${safeTerminalText(await activeLocalConfigPath())}`,
				"",
				"Repair the JSON file, then reopen /sync.",
			].join("\n"),
			actions: ["Help"],
		};
	}
	if (!raw) {
		return {
			title: [
				"Manage sync",
				"",
				"Not set up.",
				"",
				"What do you want to do?",
			].join("\n"),
			actions: ["Set up sync", "Help"],
		};
	}
	const configuredTargets = ownRecord(raw.syncSetups);
	if (
		raw.version === 3 &&
		configuredTargets &&
		Object.keys(configuredTargets).length === 0
	) {
		return {
			title: [
				"Manage sync",
				"",
				"No sync setups are configured.",
				"Add a sync setup using an existing storage connection.",
				"",
				"What do you want to do?",
			].join("\n"),
			actions: ["Sync setups…", "Storage connections…", "Help"],
		};
	}
	try {
		const config = await loadConfig();
		const operation = await inspectOperation();
		const changesBlocked = operationBlocksChanges(operation);
		let currentAttention: SyncAttentionState | undefined;
		if (attention) {
			try {
				const attentionConfig =
					attention.decision.setupName === config.setupName
						? config
						: await loadConfig(attention.decision.setupName);
				if (syncAttentionMatchesConfig(attention, attentionConfig))
					currentAttention = attention;
			} catch {
				currentAttention = undefined;
			}
			if (signal?.aborted) throw signal.reason;
		}
		const attentionComparison = currentAttention
			? compareSyncInclude(
					currentAttention.decision.localInclude,
					currentAttention.decision.remoteInclude,
				)
			: undefined;
		const noSyncedContent = config.include.length === 0;
		const syncState = changesBlocked
			? undefined
			: await readStateForConfig(config).catch(() => undefined);
		const lastAppliedSnapshot = changesBlocked
			? "Unavailable while operations are locked"
			: syncState?.lastAppliedSnapshot
				? safeTerminalText(syncState.lastAppliedSnapshot)
				: syncState
					? "Never synced"
					: "Unavailable";
		const canSwitch =
			(await countValidSyncSetups(configuredTargets, signal)) > 1;
		const mainActions = MAIN_MENU_ACTIONS.filter(
			(action) => action !== "Switch sync setup" || canSwitch,
		);
		const ordinaryTitle = [
			"Manage sync",
			"",
			`Current sync setup: ${safeTerminalText(config.setupName)}`,
			`Storage: ${backendStorageDescription(config)}`,
			`Included: ${formatIncludedContentSummary(config.include)}`,
			`Automatic sync: ${config.automatic ? "On" : "Off"}`,
			`Last applied: ${lastAppliedSnapshot}`,
			...(currentAttention
				? [
						currentAttention.decision.setupName === config.setupName
							? "Sync status: Review needed"
							: `Sync status: Review needed for setup ${safeTerminalText(currentAttention.decision.setupName)}`,
						attentionComparison?.remoteOnly.length === 0 &&
						attentionComparison.localOnly.length === 0
							? "Only the synced-content order differs."
							: `Remote-only paths: ${attentionComparison?.remoteOnly.length ?? 0} · Device-only paths: ${attentionComparison?.localOnly.length ?? 0}`,
						"Nothing has been changed.",
					]
				: ["Remote status: Not checked"]),
			...(noSyncedContent
				? [
						"",
						"No included content is selected. Choose included content in Settings before syncing.",
					]
				: []),
			"",
			"What do you want to do?",
		];
		return {
			title: (changesBlocked
				? ["Manage sync", ...operationStatusLines(operation)]
				: ordinaryTitle
			).join("\n"),
			actions: operationActions(
				operation,
				noSyncedContent,
				canSwitch,
				mainActions,
			),
			operation,
			...(currentAttention
				? {
						attention: currentAttention,
						attentionBlocksSync:
							currentAttention.decision.setupName === config.setupName,
						attentionReviewDisabled: changesBlocked,
					}
				: {}),
		};
	} catch (error) {
		if (signal?.aborted) throw error;
		return {
			title: [
				"Manage sync",
				"",
				"Settings need attention. Automatic sync is paused.",
				`Current sync setup: ${safeTerminalText(typeof raw.activeSyncSetup === "string" ? raw.activeSyncSetup : "none")}`,
				`Error: ${safeTerminalText(errorMessage(error))}`,
				`File: ${safeTerminalText(await activeLocalConfigPath())}`,
				"",
				"What do you want to do?",
			].join("\n"),
			actions: [
				"Sync setups…",
				"Storage connections…",
				"History & recovery…",
				"Help",
			],
		};
	}
}

function operationActions(
	operation: OperationAvailability,
	noSyncedContent: boolean,
	canSwitch: boolean,
	mainActions: string[],
) {
	if (operationCanRecover(operation)) {
		return [
			"Restore sync access… (recommended)",
			"Status & changes",
			"History & recovery…",
			"Help",
		];
	}
	if (operation.kind !== "free") {
		return [
			"Refresh operation status",
			"Status & changes",
			"History & recovery…",
			"Help",
		];
	}
	return noSyncedContent
		? [
				"Settings",
				...(canSwitch ? ["Switch sync setup"] : []),
				"Status & changes",
				"More…",
			]
		: mainActions;
}

function operationStatusLines(operation: OperationAvailability): string[] {
	switch (operation.kind) {
		case "free":
			return [];
		case "live": {
			const command = truncateToWidth(
				safeTerminalText(operation.lock.command),
				16,
				"…",
			);
			return [
				`Running: ${command} (pid ${operation.lock.pid}). Wait, then refresh; Settings and More return.`,
			];
		}
		case "busy":
			return [
				"Pi-sync may be starting or finishing. Wait, then refresh; Settings and More remain unavailable.",
			];
		case "recoverable-stale":
			return [
				"Sync paused: old lock remains. Close other Pi sessions then restore; Settings and More return.",
			];
		case "recoverable-unreadable":
			return [
				"Sync paused: owner unknown. Close other Pi sessions then restore; Settings and More return.",
			];
		case "inspection-error":
			return [
				"Lock check failed. Fix path access, then refresh; Settings and More remain unavailable.",
			];
	}
}

export function backendStorageDescription(config: AnySyncConfig) {
	const connection = safeTerminalText(config.connectionName);
	return `Git · ${connection} · ${safeTerminalText(config.backend.destination.branch)}`;
}
