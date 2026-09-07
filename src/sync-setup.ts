import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	agentDir,
	localConfigTemplate,
	readLocalConfigObject,
	updateLocalConfig,
} from "./config.js";
import { selectIncludedContent } from "./file-selection.js";
import {
	normalizeGitBranch,
	normalizeGitDirectory,
	normalizeGitRemote,
} from "./git-config.js";
import { inspectLock, isStaleLock, unlock } from "./lock.js";
import { safeTerminalText } from "./manager-helpers.js";
import { singleTargetSetup } from "./single-target.js";
import {
	migrateLegacyStateDirectory,
	stateDirectoryMigrationNotice,
	withStateDirectoryAccess,
} from "./state-directory.js";
import { DEFAULT_SYNC_INCLUDE } from "./sync-policy.js";

export async function prepareSyncSetup(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
) {
	if (ctx.mode !== "tui") return true;
	if (stateDirectoryMigrationNotice()) {
		const choice = await ctx.ui.select(
			"Legacy pi-sync state directory found",
			["Keep existing state directory", "Migrate state directory…", "Cancel"],
			{ signal },
		);
		if (!choice || choice === "Cancel") return false;
		if (choice === "Migrate state directory…") {
			if (
				!(await ctx.ui.confirm(
					"Migrate pi-sync state directory?",
					"Confirm that every other Pi process is closed. Rename .pisync/ to pi-sync/ without merging or deleting data.",
					{ signal },
				))
			)
				return false;
			signal?.throwIfAborted();
			const result = await migrateLegacyStateDirectory();
			if (result.status !== "ready")
				ctx.ui.notify(
					result.message,
					result.status === "migrated" ? "info" : "warning",
				);
			if (result.status !== "ready" && result.status !== "migrated")
				return false;
		}
	}
	return withStateDirectoryAccess(async () => {
		const lock = await inspectLock();
		if (lock.status === "missing") return true;
		if (lock.status === "valid" && !isStaleLock(lock.lock))
			throw new Error(
				"A sync lock owner is still live. Retry setup when it finishes.",
			);
		if (
			!(await ctx.ui.confirm(
				"Restore sync access?",
				"Confirm every other Pi process is closed and no sync is running. Remove the abandoned lock only after guarded ownership checks; no content is changed.",
				{ signal },
			))
		)
			return false;
		await unlock(ctx, {
			yes: true,
			force: false,
			stale: true,
			silent: false,
			reload: false,
			auto: false,
			args: [],
			signal,
		});
		return (await inspectLock()).status === "missing";
	});
}

export async function showSyncSetup(
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"Run /sync setup in TUI mode to select files and review the destination.",
			"warning",
		);
		return;
	}
	const original = (await readLocalConfigObject()) ?? localConfigTemplate();
	signal?.throwIfAborted();
	const names = Object.keys(original.syncSetups);
	let name = names[0] ?? "default";
	if (names.length > 1) {
		try {
			name = singleTargetSetup(original);
		} catch {
			const labels = names.map(
				(candidate, index) => `${index + 1}. ${safeTerminalText(candidate)}`,
			);
			const selected = await ctx.ui.select(
				"Choose one legacy target to review (all others remain untouched)",
				labels,
				{ signal },
			);
			signal?.throwIfAborted();
			if (!selected || !labels.includes(selected)) return;
			name = names[labels.indexOf(selected)];
		}
	}
	const previous = original.syncSetups[name];
	const connection = previous
		? original.storageConnections[previous.storage.connection]
		: undefined;
	const include = await selectIncludedContent(
		ctx,
		previous?.sync.include ?? DEFAULT_SYNC_INCLUDE,
		signal,
	);
	if (!include) return;

	const hasExisting = Boolean(original.syncSetups[name]);

	// 已有配置下，选完文件立即落盘保存当前同步项并直接结束！不再弹窗骚扰
	if (hasExisting && connection?.remote && original.singleTargetSetup) {
		await updateLocalConfig((current) => {
			const targetSetup = current.syncSetups[name];
			if (!targetSetup) return current;
			return {
				...current,
				syncSetups: {
					...current.syncSetups,
					[name]: {
						...targetSetup,
						sync: { ...targetSetup.sync, include, automatic: false },
					},
				},
			};
		}, signal);
		ctx.ui.notify(
			`同步内容已更新并自动保存！(共 ${include.length} 项)\nGit 目标保持: ${safeTerminalText(connection.remote)} (${safeTerminalText(previous.storage.branch ?? "main")})\n输入 /sync 即可开始同步。`,
			"info",
		);
		return;
	}

	const agentDirectory = agentDir();
	const remoteInput = await ctx.ui.input(
		`Git repository (Source: ${safeTerminalText(agentDirectory)})\nDestination for syncing files from your local Pi directory. Uses existing SSH/Git credentials.`,
		connection?.remote ?? "git@github.com:owner/private-pi-sync.git",
		{ signal },
	);
	if (remoteInput === undefined) {
		ctx.ui.notify(
			`已自动保存同步内容项！(共 ${include.length} 项)\nGit 目标未更改。`,
			"info",
		);
		return;
	}
	const remote = normalizeGitRemote(
		remoteInput.trim() || connection?.remote || "",
	);
	if (!remote) throw new Error("A Git repository is required.");

	const branchInput = await ctx.ui.input(
		"Owned Git branch (Dedicated branch owned by Pi Sync)",
		previous?.storage.branch ?? "main",
		{ signal },
	);
	if (branchInput === undefined) {
		ctx.ui.notify(
			`已自动保存同步内容项！(共 ${include.length} 项)\nGit 目标未更改。`,
			"info",
		);
		return;
	}
	const branch = normalizeGitBranch(
		branchInput.trim() || previous?.storage.branch || "main",
	);

	const pathInput = await ctx.ui.input(
		"Repository path (Directory inside the repository, e.g. ./)",
		previous?.storage.path ?? "./",
		{ signal },
	);
	if (pathInput === undefined) {
		ctx.ui.notify(
			`已自动保存同步内容项！(共 ${include.length} 项)\nGit 目标未更改。`,
			"info",
		);
		return;
	}
	const storagePath = normalizeGitDirectory(
		pathInput.trim() || previous?.storage.path || "./",
	);

	if (
		include.includes("sessions") &&
		!previous?.sync.include.includes("sessions")
	) {
		if (
			!(await ctx.ui.confirm(
				"Include session conversations?",
				"Sessions may contain prompts, tool output, paths, images, and secrets. Include only in trusted private storage.",
				{ signal },
			))
		)
			return;
	}
	signal?.throwIfAborted();
	await updateLocalConfig((current) => {
		let connectionName = previous?.storage.connection ?? "default";
		const shared = Object.entries(current.syncSetups).some(
			([key, setup]) =>
				key !== name && setup.storage.connection === connectionName,
		);
		if (
			(!previous &&
				Object.hasOwn(current.storageConnections, connectionName)) ||
			(shared && connection?.remote !== remote)
		) {
			let suffix = 1;
			while (Object.hasOwn(current.storageConnections, `sync-${suffix}`))
				suffix += 1;
			connectionName = `sync-${suffix}`;
		}
		return {
			...current,
			activeSyncSetup: name,
			singleTargetSetup: name,
			storageConnections: {
				...current.storageConnections,
				[connectionName]: { ...connection, type: "git", remote },
			},
			syncSetups: {
				...current.syncSetups,
				[name]: {
					...previous,
					storage: {
						...previous?.storage,
						connection: connectionName,
						branch,
						path: storagePath,
					},
					sync: { ...previous?.sync, include, automatic: false },
				},
			},
		};
	}, signal);
	ctx.ui.notify(
		`设置已自动保存！\n来源: ${safeTerminalText(agentDirectory)}\n目标: ${safeTerminalText(remote)} (${safeTerminalText(branch)}:${safeTerminalText(storagePath)})\n同步项: ${include.map(safeTerminalText).join(", ") || "none"}\n输入 /sync 即可开始同步。`,
		"info",
	);
}
