import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { syncConfigReviewFingerprint } from "./config.js";
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

export function syncAttentionMatchesConfig(attention: SyncAttentionState, config: AnySyncConfig) {
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
						truncateToWidth(theme.fg(index === 0 ? "warning" : "muted", line), safeWidth, "…"),
					);
				},
				invalidate() {},
			}));
		},
	};
}

function attentionPresentation(decision: RemoteSelectionDecision) {
	const setupName = safeTerminalText(decision.setupName);
	const comparison = compareSyncInclude(decision.localInclude, decision.remoteInclude);
	const difference =
		comparison.remoteOnly.length === 0 && comparison.localOnly.length === 0
			? "Only list order differs"
			: `Remote ${comparison.remoteOnly.length} · Device ${comparison.localOnly.length}`;
	return {
		status: "review needed",
		lines: [`Pi Sync needs review · ${setupName}`, difference, "No changes · Run /sync to review"],
	};
}

function clearAttentionPresentation(ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}
