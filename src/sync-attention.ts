import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ActionMenuItem } from "@narumitw/pi-tui-kit";
import type { RunRoute } from "./cancellable-operation.js";
import { syncConfigReviewFingerprint } from "./config.js";
import type { ManagerDescription } from "./manager-state.js";
import { safeTerminalText } from "./sync-format.js";
import {
	compareSyncInclude,
	type RemoteSelectionDecision,
	sameSyncInclude,
} from "./sync-policy.js";
import type { AnySyncConfig } from "./types.js";

const STATUS_KEY = "sync";
const WIDGET_KEY = "sync:attention";

export type SyncAttentionOrigin = "sync" | "pull" | "push";

export interface SyncAttentionState {
	decision: RemoteSelectionDecision;
	origin: SyncAttentionOrigin;
	offered: boolean;
}

export function syncAttentionMatchesConfig(
	attention: SyncAttentionState,
	config: AnySyncConfig,
) {
	return (
		attention.decision.setupName === config.setupName &&
		attention.decision.configIdentity === syncConfigReviewFingerprint(config) &&
		sameSyncInclude(attention.decision.localInclude, config.include)
	);
}

export interface SyncAttentionController {
	set(decision: RemoteSelectionDecision, origin: SyncAttentionOrigin): void;
	current(): SyncAttentionState | undefined;
	markOffered(): boolean;
	clear(ctx: ExtensionContext): void;
	reset(ctx: ExtensionContext): void;
	publish(ctx: ExtensionContext): void;
}

export function createSyncAttentionController(): SyncAttentionController {
	let state: SyncAttentionState | undefined;

	return {
		set(decision, origin) {
			state = { decision, origin, offered: false };
		},
		current() {
			return state;
		},
		markOffered() {
			if (!state || state.offered) return false;
			state = { ...state, offered: true };
			return true;
		},
		clear(ctx) {
			state = undefined;
			clearAttentionPresentation(ctx);
		},
		reset(ctx) {
			state = undefined;
			clearAttentionPresentation(ctx);
		},
		publish(ctx) {
			if (!state) {
				clearAttentionPresentation(ctx);
				return;
			}
			const presentation = attentionPresentation(state.decision);
			ctx.ui.setStatus(STATUS_KEY, presentation.status);
			if (ctx.mode !== "tui") return;
			ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
				render(width: number) {
					const safeWidth = Math.max(1, width);
					return presentation.lines.map((line, index) =>
						truncateToWidth(
							theme.fg(index === 0 ? "warning" : "muted", line),
							safeWidth,
							"…",
						),
					);
				},
				invalidate() {},
			}));
		},
	};
}

function attentionPresentation(decision: RemoteSelectionDecision) {
	const setupName = safeTerminalText(decision.setupName);
	const comparison = compareSyncInclude(
		decision.localInclude,
		decision.remoteInclude,
	);
	const difference =
		comparison.remoteOnly.length === 0 && comparison.localOnly.length === 0
			? "Only list order differs"
			: `Remote ${comparison.remoteOnly.length} · Device ${comparison.localOnly.length}`;
	return {
		status: "review needed",
		lines: [
			`Pi Sync needs review · ${setupName}`,
			difference,
			"No changes · Run /sync to review",
		],
	};
}

function clearAttentionPresentation(ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export interface SyncManagerAttentionOptions {
	getAttention?: () => SyncAttentionState | undefined;
	onSelectionResolved?: (expected: SyncAttentionState) => void;
}

export function attentionMainMenuItems(
	manager: ManagerDescription,
): ActionMenuItem<"main" | "more" | "recovery", "review-attention">[] {
	if (!manager.attention) return [];
	const disabled = manager.attentionReviewDisabled === true;
	return [
		{
			id: "review-attention",
			label: "Review synced content (recommended)",
			action: "review-attention",
			...(disabled
				? {
						disabled: true,
						disabledReason: "Finish or recover the active operation first.",
					}
				: {}),
		},
	];
}

export function blockedSyncMenuItem(
	label: string,
	manager: ManagerDescription,
): ActionMenuItem<"main" | "more" | "recovery", "sync"> | undefined {
	if (label !== "Sync now (recommended)" || !manager.attentionBlocksSync)
		return undefined;
	return {
		id: "sync",
		label,
		description: "Review first.",
		action: "sync",
		disabled: true,
		disabledReason: "Review synced content first.",
	};
}

export async function showManagerAttention(
	ctx: ExtensionCommandContext,
	attention: SyncAttentionState,
	runRoute: RunRoute,
	signal: AbortSignal | undefined,
	onSelectionResolved: (() => void) | undefined,
): Promise<"close" | "stay"> {
	const { showRemoteSelectionReview } = await import(
		"./remote-selection-ui.js"
	);
	if (signal?.aborted) return "close";
	const review = await showRemoteSelectionReview(
		ctx,
		attention.decision.setupName,
		signal,
		undefined,
		{
			decision: attention.decision,
			origin: attention.origin,
			runRoute,
			onSelectionResolved,
		},
	);
	if (review.kind === "route-result") {
		const { dispatchManagerResult } = await import(
			"./manager-result-dispatcher.js"
		);
		const disposition = await dispatchManagerResult(
			ctx,
			review.result,
			review.route,
			runRoute,
			signal,
			{ onSelectionResolved },
		);
		return disposition.kind;
	}
	return review.kind === "closed" || review.kind === "stale" ? "close" : "stay";
}
