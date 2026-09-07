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
	BUILT_IN_SYNC_ROOTS,
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
	"settings.json":
		"全局设置 (包含用 pi install 安装的所有插件清单 packages、主题选择 dark/light、模型偏好)",
	"keybindings.json": "自定义快捷键配置",
	"models.json": "自定义大模型端点与 Provider 配置",
	"lsp.json": "语言服务器 (LSP) 补全与诊断配置",
	"AGENTS.md": "全局系统指令与 Agent 指南",
	"APPEND_SYSTEM.md": "追加系统提示词规则",
	skills: "自定义技能目录 (自定义工具与 Agent 流程)",
	prompts: "提示词模板目录",
	themes:
		"自定义配色文件目录 (备注: 仅用于自己手写的配色文件；普通内置主题 dark/light 无需勾选)",
	extensions:
		"本地自写扩展脚本目录 (备注: 仅用于自己手写的独立 .ts 脚本；用 pi install 安装的插件无需勾选)",
	"token-usage.jsonl":
		"Token 消耗流水账 (仅记录使用量与成本元数据，不含对话文本)",
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

export async function selectIncludedContent(
	ctx: ExtensionCommandContext,
	include: readonly string[],
	signal?: AbortSignal,
) {
	const normalized = normalizeSyncInclude(include);
	const draft: SelectionDraft = {
		paths: new Set(normalized),
		extraCandidates: new Set(
			normalized.filter((item) => !PRIMARY_PATHS.has(item)),
		),
	};
	await showSetupItemSelector(ctx, draft, signal);
	if (signal?.aborted) return undefined;
	return normalizeSyncInclude([...draft.paths]);
}

async function showSetupItemSelector(
	ctx: ExtensionCommandContext,
	draft: SelectionDraft,
	signal?: AbortSignal,
) {
	const agentDirectory = agentDir();
	const allSelectablePaths = [...BUILT_IN_SYNC_ROOTS, ...draft.extraCandidates];
	const statusBadges = await collectStatusBadges(allSelectablePaths);

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
				title: "选择同步内容 (Select Content)",
				lines: [
					`源根目录 (来自): ${safeTerminalText(agentDirectory)}`,
					"提示: 勾选需要通过 Git 同步的文件或目录。密钥 auth.json 会被永久排除。",
					"取消勾选不会删除本地或远端文件。下一步将设置目标 Git 仓库。",
				],
				viewportSize: 15,
				items: [
					...BUILT_IN_SYNC_ROOTS.map((relativePath) => {
						const badge = statusBadges.get(relativePath);
						const descText = BUILT_IN_DESCRIPTIONS[relativePath] ?? "";
						const fullPath = path.join(agentDirectory, relativePath);
						return {
							id: `${BUILT_IN_PREFIX}${relativePath}`,
							label: `${safeTerminalText(relativePath)}${relativePath.includes(".") ? "" : "/"}`,
							description: [badge, descText, `[${fullPath}]`]
								.filter(Boolean)
								.join(" · "),
							selected: draft.paths.has(relativePath),
						};
					}),
					...[...draft.extraCandidates]
						.filter((p) => !BUILT_IN_SYNC_ROOTS.includes(p as never))
						.sort((left, right) => left.localeCompare(right))
						.map((relativePath) => {
							const badge = statusBadges.get(relativePath);
							let descText: string;
							if (relativePath === SESSIONS_ID) {
								descText =
									"聊天会话历史（可能包含对话文本、工具输出与代码片段，建议仅在可信私有仓库勾选）";
							} else {
								descText = "自定义添加的相对路径";
							}
							const fullPath = path.join(agentDirectory, relativePath);
							return {
								id: `extra:${relativePath}`,
								label: safeTerminalText(relativePath),
								description: [badge, descText, `[${fullPath}]`]
									.filter(Boolean)
									.join(" · "),
								selected: draft.paths.has(relativePath),
							};
						}),
				],
				action: "toggle",
				actions: [
					{
						id: ADD_CUSTOM_ID,
						label: "+ 添加自定义路径…",
						description: "添加 ~/.pi/agent/ 下的其他自定义相对文件或目录",
						action: "addCustom",
					},
				],
				hint: "close",
				doneLabel: "完成选择并继续",
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

async function showDraftEditor(
	ctx: ExtensionCommandContext,
	setupName: string,
	draft: SelectionDraft,
	signal?: AbortSignal,
	setupReview = false,
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
					setupReview
						? "Draft only · next, review the exact destination and selection before saving. Deselecting never deletes content."
						: "Draft only · leaving this screen opens Save, Discard, or Continue editing.",
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
