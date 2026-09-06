import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
	agentDir,
	loadConfig,
	localConfigPath,
	updateSyncSetup,
} from "./config.js";
import { safeTerminalText } from "./manager-helpers.js";
import { toPosix } from "./paths.js";
import {
	canonicalBuiltInSyncRoot,
	isSafeCustomIncludePath,
	normalizeSyncInclude,
	PRIMARY_CATEGORIES,
} from "./sync-policy.js";

const BUILT_IN_PREFIX = "builtin:";
const CUSTOM_PREFIX = "custom:";
const SESSIONS_ID = "sessions";
const ADD_CUSTOM_ID = "add-custom";

const PRIMARY_PATHS = new Set<string>(
	PRIMARY_CATEGORIES.flatMap((category) => category.paths),
);

const BUILT_IN_DESCRIPTIONS: Record<string, string> = {
	"settings.json": "Global settings (model preferences, compaction, tools)",
	"keybindings.json": "Custom key shortcuts and bindings",
	"models.json": "Custom provider endpoints and model definitions",
	"lsp.json": "Language server (LSP) configurations",
	"AGENTS.md": "Global system prompt instructions and agent guidelines",
	"APPEND_SYSTEM.md": "Appended system prompt rules",
	skills: "Agent skills directory (custom tools and workflows)",
	prompts: "Prompt templates directory",
	themes: "TUI color themes directory",
	extensions: "Local extension modules",
	"token-usage.jsonl":
		"Token usage ledger (pi-token-usage metadata without chat text)",
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function collectStatusBadges(
	paths: Iterable<string>,
): Promise<Map<string, string>> {
	const badges = new Map<string, string>();
	await Promise.all(
		[...paths].map(async (relativePath) => {
			try {
				const stat = await fs.stat(path.join(agentDir(), relativePath));
				if (stat.isFile()) {
					badges.set(relativePath, `[${formatBytes(stat.size)}]`);
				} else if (stat.isDirectory()) {
					badges.set(relativePath, "[dir]");
				}
			} catch {
				badges.set(relativePath, "[absent]");
			}
		}),
	);
	return badges;
}

interface SelectionDraft {
	readonly paths: Set<string>;
	readonly extraCandidates: Set<string>;
}

export async function showFileSelection(
	ctx: ExtensionCommandContext,
	setupName?: string,
	signal?: AbortSignal,
) {
	const config = await loadConfig(setupName);
	if (signal?.aborted) return;
	const normalized = normalizeSyncInclude(config.include);
	const original: SelectionDraft = {
		paths: new Set(normalized),
		extraCandidates: new Set(
			normalized.filter((item) => !PRIMARY_PATHS.has(item)),
		),
	};
	const draft = cloneDraft(original);

	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			[
				`pi-sync included content for sync setup ${safeTerminalText(config.setupName)}:`,
				`include: ${config.include.map(safeTerminalText).join(", ") || "none"}`,
				`Edit sync.include in ${safeTerminalText(localConfigPath())}.`,
			].join("\n"),
			"info",
		);
		return;
	}

	while (!signal?.aborted) {
		await showDraftEditor(ctx, config.setupName, draft, signal);
		if (signal?.aborted || sameDraft(original, draft)) return;
		const choice = await showDraftReview(ctx, original, draft, signal);
		if (signal?.aborted) return;
		if (choice === "Continue editing") continue;
		if (choice !== "Save changes") {
			ctx.ui.notify("Included-content changes discarded.", "info");
			return;
		}
		try {
			if (!original.paths.has(SESSIONS_ID) && draft.paths.has(SESSIONS_ID)) {
				const acknowledged = await ctx.ui.confirm(
					"Include session conversations?",
					"Session JSONL may contain prompts, tool output, file paths, images, and secrets. Continue only with storage you trust.",
					{ signal },
				);
				if (signal?.aborted) return;
				if (!acknowledged) {
					ctx.ui.notify("Session inclusion was not saved.", "info");
					return;
				}
			}
			const primaryOrdered = PRIMARY_CATEGORIES.flatMap(
				(cat) => cat.paths,
			).filter((p) => draft.paths.has(p));
			const extraOrdered = [...draft.extraCandidates]
				.filter(
					(p) =>
						draft.paths.has(p) && p !== SESSIONS_ID && !PRIMARY_PATHS.has(p),
				)
				.sort((left, right) => left.localeCompare(right));
			const sessionsPart = draft.paths.has(SESSIONS_ID) ? [SESSIONS_ID] : [];
			const include = normalizeSyncInclude([
				...primaryOrdered,
				...extraOrdered,
				...sessionsPart,
			]);
			if (signal?.aborted) return;
			await updateSyncSetup(
				config.setupName,
				(setup) => ({
					...setup,
					sync: { ...setup.sync, include },
				}),
				{ expectedInclude: config.include, signal },
			);
			if (signal?.aborted) return;
			ctx.ui.notify(
				`Saved included content for sync setup “${safeTerminalText(config.setupName)}”. It applies to the next manual or automatic sync.`,
				"info",
			);
		} catch (error) {
			if (signal?.aborted) return;
			ctx.ui.notify(
				`Could not save pi-sync file selection: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
				"error",
			);
		}
		return;
	}
}

async function showDraftEditor(
	ctx: ExtensionCommandContext,
	setupName: string,
	draft: SelectionDraft,
	signal?: AbortSignal,
) {
	const statusBadges = await collectStatusBadges([
		...PRIMARY_PATHS,
		...draft.extraCandidates,
	]);
	const menu = defineMenu<
		undefined,
		"editor",
		"toggle" | "addCustom",
		ExtensionCommandContext
	>({
		start: "editor",
		screens: {
			editor: () => ({
				kind: "multiSelect",
				title: `Included Content · ${safeTerminalText(setupName)}`,
				lines: [
					"auth.json and secret tokens are permanently excluded from sync.",
					"Draft only · leaving this screen opens Save, Discard, or Continue editing.",
				],
				viewportSize: 14,
				items: [
					...PRIMARY_CATEGORIES.map((category) => {
						const selectedMembers = category.paths.filter((p) =>
							draft.paths.has(p),
						);
						const isFull = selectedMembers.length === category.paths.length;
						const isPartial = selectedMembers.length > 0 && !isFull;
						let description: string;
						if (isPartial) {
							description = `${selectedMembers.length}/${category.paths.length} selected · ${selectedMembers.join(", ")} (${category.paths.join(", ")})`;
						} else if (category.paths.length > 1) {
							description = `[${selectedMembers.length}/${category.paths.length}] ${category.description}`;
						} else {
							const badge = statusBadges.get(category.paths[0]);
							description = [badge, category.description]
								.filter(Boolean)
								.join(" ");
						}
						return {
							id: category.id,
							label: category.label,
							description,
							selected: isFull,
						};
					}),
					...[...draft.extraCandidates]
						.sort((left, right) => left.localeCompare(right))
						.map((relativePath) => {
							const badge = statusBadges.get(relativePath);
							let descText: string;
							if (relativePath === SESSIONS_ID) {
								descText =
									"Session JSONL may contain prompts, tool output, paths, images, and secrets. Sync only to storage you trust.";
							} else if (BUILT_IN_DESCRIPTIONS[relativePath]) {
								descText = BUILT_IN_DESCRIPTIONS[relativePath];
							} else {
								descText = "Additional safe agent-relative file or directory.";
							}
							return {
								id: `extra:${relativePath}`,
								label: safeTerminalText(relativePath),
								description: [badge, descText].filter(Boolean).join(" "),
								selected: draft.paths.has(relativePath),
							};
						}),
				],
				action: "toggle",
				actions: [
					{
						id: ADD_CUSTOM_ID,
						label: "Add custom path…",
						description:
							"Include an agent-relative file or directory even when it exists only remotely.",
						action: "addCustom",
					},
				],
				hint: "close",
				doneLabel: "Review changes",
			}),
		},
		actions: {
			toggle: async ({ itemId, selected }) => {
				updateDraft(draft, itemId, selected === true);
				return { kind: "stay" };
			},
			addCustom: async ({ ctx: actionCtx, signal: actionSignal }) => {
				const entered = await actionCtx.ui.input(
					"Add included content",
					"Agent-relative path, for example custom.toml or snippets",
					{ signal: actionSignal },
				);
				if (actionSignal.aborted) return { kind: "stay" };
				const raw = entered?.trim();
				if (!raw) return { kind: "stay" };
				const requested = raw.replace(/[/\\]+$/u, "");
				if (!requested) return { kind: "stay" };

				let canonicalPath: string;
				const lower = requested.toLowerCase();
				if (lower === SESSIONS_ID) {
					canonicalPath = SESSIONS_ID;
				} else {
					const builtIn = canonicalBuiltInSyncRoot(requested);
					if (builtIn) {
						canonicalPath = builtIn;
					} else {
						const posixPath = toPosix(requested);
						if (!isSafeCustomIncludePath(posixPath)) {
							actionCtx.ui.notify(
								"Could not add included content: Enter a safe agent-relative file or directory path.",
								"error",
							);
							return { kind: "stay" };
						}
						canonicalPath = posixPath;
					}
				}

				if (draft.paths.has(canonicalPath)) {
					return { kind: "stay" };
				}

				try {
					normalizeSyncInclude([...draft.paths, canonicalPath]);
				} catch (error) {
					if (actionSignal.aborted) return { kind: "stay" };
					actionCtx.ui.notify(
						`Could not add included content: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
						"error",
					);
					return { kind: "stay" };
				}

				draft.paths.add(canonicalPath);
				if (!PRIMARY_PATHS.has(canonicalPath)) {
					draft.extraCandidates.add(canonicalPath);
				}
				return { kind: "stay" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal,
		isCurrent: () => !signal?.aborted,
	});
}

async function showDraftReview(
	ctx: ExtensionCommandContext,
	original: SelectionDraft,
	draft: SelectionDraft,
	signal?: AbortSignal,
) {
	let choice:
		| "Save changes"
		| "Discard changes"
		| "Continue editing"
		| undefined;
	const menu = defineMenu<
		undefined,
		"review",
		"choose",
		ExtensionCommandContext
	>({
		start: "review",
		screens: {
			review: () => ({
				kind: "actions",
				title: "Review included-content changes",
				lines: formatDraftPreview(original, draft).split("\n").slice(2),
				items: [
					{ id: "save", label: "Save changes", action: "choose" },
					{ id: "discard", label: "Discard changes", action: "choose" },
					{ id: "continue", label: "Continue editing", action: "choose" },
				],
				hint: "close",
			}),
		},
		actions: {
			choose: async ({ itemId }) => {
				choice =
					itemId === "save"
						? "Save changes"
						: itemId === "continue"
							? "Continue editing"
							: "Discard changes";
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal,
		isCurrent: () => !signal?.aborted,
	});
	return choice;
}

function updateDraft(draft: SelectionDraft, id: string, included: boolean) {
	if (id.startsWith("category:")) {
		const category = PRIMARY_CATEGORIES.find((cat) => cat.id === id);
		if (!category) throw new Error(`Unknown category: ${id}`);
		if (included) {
			for (const p of category.paths) draft.paths.add(p);
		} else {
			for (const p of category.paths) draft.paths.delete(p);
		}
		return;
	}
	if (id.startsWith("extra:")) {
		const relativePath = id.slice("extra:".length);
		if (included) draft.paths.add(relativePath);
		else draft.paths.delete(relativePath);
		return;
	}
	if (id.startsWith(CUSTOM_PREFIX)) {
		const relativePath = id.slice(CUSTOM_PREFIX.length);
		if (included) draft.paths.add(relativePath);
		else draft.paths.delete(relativePath);
		return;
	}
	if (id.startsWith(BUILT_IN_PREFIX)) {
		const relativePath = id.slice(BUILT_IN_PREFIX.length);
		if (included) draft.paths.add(relativePath);
		else draft.paths.delete(relativePath);
		return;
	}
	if (id === SESSIONS_ID) {
		if (included) draft.paths.add(SESSIONS_ID);
		else draft.paths.delete(SESSIONS_ID);
		return;
	}
	throw new Error(`Unknown file selection: ${id}`);
}

function formatDraftPreview(original: SelectionDraft, draft: SelectionDraft) {
	const lines = ["Review included-content changes", ""];
	const allPaths = new Set([...original.paths, ...draft.paths]);
	const sortedPaths = [...allPaths].sort((left, right) => {
		if (left === SESSIONS_ID) return 1;
		if (right === SESSIONS_ID) return -1;
		return left.localeCompare(right);
	});
	for (const item of sortedPaths) {
		const before = original.paths.has(item);
		const after = draft.paths.has(item);
		if (before !== after) {
			lines.push(`${after ? "Include" : "Exclude"}: ${safeTerminalText(item)}`);
		}
	}
	lines.push("", "Saving does not start a network sync.");
	return lines.join("\n");
}

function cloneDraft(value: SelectionDraft): SelectionDraft {
	return {
		paths: new Set(value.paths),
		extraCandidates: new Set(value.extraCandidates),
	};
}

function sameDraft(left: SelectionDraft, right: SelectionDraft) {
	return sameSet(left.paths, right.paths);
}

function sameSet(left: Set<string>, right: Set<string>) {
	return left.size === right.size && [...left].every((item) => right.has(item));
}
