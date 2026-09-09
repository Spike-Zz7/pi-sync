import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { agentDir } from "./config.js";
import {
	assertWithinRoot,
	isDeniedPath,
	isPathInside,
	parentPaths,
	safeJoin,
	toPosix,
} from "./paths.js";
import { withSyncSettingsLocks } from "./settings-lock.js";
import {
	createSnapshot,
	isSessionFilePath,
	isSessionPath,
	sessionStorageRoot,
	snapshotIncludesSessions,
	snapshotTarget,
} from "./snapshot.js";
import {
	applySnapshotTransaction,
	recoverPendingSnapshotTransactions,
} from "./snapshot-transaction.js";
import type { Snapshot, SnapshotApplyPlan, SnapshotOptions } from "./types.js";

function sha256(value: Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

function fileHashMap(snapshot: Snapshot) {
	return Object.fromEntries(
		snapshot.files.map((file) => [file.path, file.sha256]),
	);
}

async function applySnapshotUnlocked(
	snapshot: Snapshot,
	protectedRelativePaths = new Set<string>(),
	options: Pick<
		SnapshotOptions,
		"include" | "sessionDir" | "syncFiles" | "syncSessions" | "extraFiles"
	> & {
		additionalWrites?: SnapshotApplyPlan["writes"];
		additionalDeletes?: string[];
	} = {},
) {
	const root = agentDir();
	const { sessionDir } = options;
	await recoverPendingSnapshotTransactions();
	const current = await createSnapshot(snapshot.profile, {
		...options,
		...(options.include === undefined
			? { syncSessions: snapshotIncludesSessions(snapshot) }
			: {}),
		sessionDir,
	});
	const plan = await addTopLevelCaseVariantDeletes(
		root,
		protectSnapshotApplyPlan(
			root,
			preflightSnapshotApply(root, snapshot, current, { sessionDir }),
			protectedRelativePaths,
			sessionDir,
		),
		snapshot,
	);
	if (options.additionalWrites) plan.writes.push(...options.additionalWrites);
	if (options.additionalDeletes)
		plan.deletes.push(...options.additionalDeletes);
	for (const item of plan.writes) {
		if (isPathInside(root, item.target)) {
			let parent = path.dirname(item.target);
			while (parent !== root && path.dirname(parent) !== root) {
				try {
					const stat = await fs.lstat(parent);
					if (stat.isSymbolicLink()) {
						plan.deletes.push(parent);
					}
				} catch (error) {
					if (
						(error as NodeJS.ErrnoException).code !== "ENOENT" &&
						(error as NodeJS.ErrnoException).code !== "ENOTDIR"
					)
						throw error;
				}
				parent = path.dirname(parent);
			}
		}
		try {
			const stat = await fs.lstat(item.target);
			if (stat.isSymbolicLink()) {
				plan.deletes.push(item.target);
			}
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "ENOENT" &&
				(error as NodeJS.ErrnoException).code !== "ENOTDIR"
			)
				throw error;
		}
	}
	plan.deletes = [...new Set(plan.deletes)];
	await preflightSnapshotMutations(root, plan, sessionDir);
	await applySnapshotTransaction(plan, {
		sessionDir,
		beforeWrite: (target) =>
			prepareSnapshotWrite(
				rootForTarget(root, target, sessionDir),
				target,
				new Set(),
			),
	});
	return appliedFileHashMap(snapshot, current, protectedRelativePaths);
}

export function preflightSnapshotApply(
	root: string,
	snapshot: Snapshot,
	current: Snapshot,
	options: { sessionDir?: string } = {},
): SnapshotApplyPlan {
	const seenPaths = new Set<string>();
	const remotePaths = new Set<string>();
	const writes: Array<{ target: string; content: Buffer; mode?: number }> = [];
	const deletes: string[] = [];

	for (const file of snapshot.files) {
		const normalized = toPosix(file.path);
		if (!isSafeSnapshotPath(file.path)) {
			throw new Error(`Unsafe path in snapshot: ${file.path}`);
		}
		if (isSessionPath(normalized) && !isSessionFilePath(normalized)) {
			throw new Error(`Unsafe session path in snapshot: ${file.path}`);
		}
		if (seenPaths.has(normalized))
			throw new Error(`Duplicate path in snapshot: ${normalized}`);
		seenPaths.add(normalized);
		remotePaths.add(normalized);

		const target = snapshotTarget(root, normalized, options.sessionDir);
		const content = decodeBase64Strict(file.contentBase64, normalized);
		if (sha256(content) !== file.sha256)
			throw new Error(`Checksum mismatch in snapshot file: ${normalized}`);
		writes.push({
			target,
			content,
			...(file.mode === undefined ? {} : { mode: file.mode }),
		});
	}

	const deletePaths = new Set<string>();
	for (const file of current.files) {
		const normalized = toPosix(file.path);
		if (!remotePaths.has(normalized)) {
			deletePaths.add(snapshotTarget(root, normalized, options.sessionDir));
		}
		for (const remotePath of parentPaths(normalized)) {
			if (remotePaths.has(remotePath)) {
				deletePaths.add(snapshotTarget(root, remotePath, options.sessionDir));
			}
		}
	}
	deletes.push(...deletePaths);

	return { writes, deletes };
}

export function protectSnapshotApplyPlan(
	root: string,
	plan: SnapshotApplyPlan,
	protectedRelativePaths: Set<string>,
	sessionDir?: string,
): SnapshotApplyPlan {
	if (protectedRelativePaths.size === 0) return plan;
	const protectedTargets = new Set(
		[...protectedRelativePaths].map((relativePath) =>
			snapshotTarget(root, relativePath, sessionDir),
		),
	);
	return {
		writes: plan.writes.filter((item) => !protectedTargets.has(item.target)),
		deletes: plan.deletes.filter((target) => !protectedTargets.has(target)),
	};
}

export async function addTopLevelCaseVariantDeletes(
	root: string,
	plan: SnapshotApplyPlan,
	snapshot: Pick<Snapshot, "files">,
): Promise<SnapshotApplyPlan> {
	const topLevelPaths = new Map<string, string>();
	for (const file of snapshot.files) {
		const normalized = toPosix(file.path);
		if (!normalized.includes("/") && isSafeSnapshotPath(file.path)) {
			topLevelPaths.set(normalized.toLowerCase(), normalized);
		}
	}
	if (topLevelPaths.size === 0) return plan;

	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return plan;
		throw error;
	}

	const deletes = new Set(plan.deletes);
	for (const entry of entries) {
		const canonicalPath = topLevelPaths.get(entry.name.toLowerCase());
		if (
			canonicalPath &&
			entry.name !== canonicalPath &&
			(entry.isFile() || entry.isSymbolicLink())
		) {
			deletes.add(safeJoin(root, entry.name));
		}
	}
	return { ...plan, deletes: [...deletes] };
}

export function appliedFileHashMap(
	snapshot: Snapshot,
	current: Snapshot,
	protectedRelativePaths: Set<string>,
) {
	const hashes = fileHashMap(snapshot);
	if (protectedRelativePaths.size === 0) return hashes;
	const currentHashes = fileHashMap(current);
	for (const relativePath of protectedRelativePaths) {
		const normalized = toPosix(relativePath);
		if (currentHashes[normalized]) {
			hashes[normalized] = currentHashes[normalized];
		} else {
			delete hashes[normalized];
		}
	}
	return hashes;
}

function isSafeSnapshotPath(relativePath: string) {
	if (relativePath.includes("\\")) return false;
	const normalized = toPosix(relativePath);
	return (
		Boolean(normalized) &&
		normalized !== "." &&
		normalized !== ".." &&
		!normalized.startsWith("../") &&
		!path.posix.isAbsolute(normalized) &&
		path.posix.normalize(normalized) === normalized &&
		!isDeniedPath(normalized)
	);
}

function decodeBase64Strict(value: string, filePath: string) {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
		throw new Error(`Invalid base64 content in snapshot file: ${filePath}`);
	}
	return Buffer.from(value, "base64");
}

async function preflightSnapshotMutations(
	root: string,
	plan: {
		deletes: string[];
		writes: Array<{ target: string; content: Buffer }>;
	},
	sessionDir?: string,
) {
	const deletePaths = new Set(plan.deletes);
	for (const target of plan.deletes) {
		await assertNoSymlinkParents(
			rootForTarget(root, target, sessionDir),
			target,
		);
	}
	for (const item of plan.writes) {
		await prepareSnapshotWrite(
			rootForTarget(root, item.target, sessionDir),
			item.target,
			deletePaths,
		);
	}
}

function rootForTarget(root: string, target: string, sessionDir?: string) {
	const sessionRoot = sessionDir
		? sessionStorageRoot(root, sessionDir)
		: undefined;
	if (sessionRoot && isPathInside(sessionRoot, target)) return sessionRoot;
	return root;
}

async function prepareSnapshotWrite(
	root: string,
	target: string,
	deletePaths: Set<string>,
) {
	const needsDeferredCheck = await inspectSnapshotWriteParents(
		root,
		path.dirname(target),
		deletePaths,
	);
	if (needsDeferredCheck) return;
	try {
		const stat = await fs.lstat(target);
		if (stat.isSymbolicLink() && !deletePaths.has(target))
			throw new Error(
				`Refusing to overwrite symlink during snapshot apply: ${target}`,
			);
		if (stat.isDirectory() && !deletePaths.has(target)) {
			throw new Error(
				`Refusing to overwrite directory during snapshot apply: ${target}`,
			);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

// A missing or scheduled-for-deletion parent defers target checks until the
// transaction's write phase. Preflight must not create directories.
async function inspectSnapshotWriteParents(
	root: string,
	directory: string,
	deletePaths: Set<string>,
) {
	assertWithinRoot(root, directory);
	const rootPath = path.resolve(root);
	const relative = path.relative(rootPath, path.resolve(directory));
	let current = rootPath;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) {
				if (deletePaths.has(current)) return true;
				throw new Error(
					`Refusing to follow symlink during snapshot apply: ${current}`,
				);
			}
			if (!stat.isDirectory()) {
				if (deletePaths.has(current)) return true;
				throw new Error(`Snapshot path parent is not a directory: ${current}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return true;
		}
	}
	return false;
}

async function assertNoSymlinkParents(root: string, target: string) {
	assertWithinRoot(root, target);
	const rootPath = path.resolve(root);
	const relative = path.relative(rootPath, path.resolve(target));
	let current = rootPath;
	const parts = relative.split(path.sep).filter(Boolean);
	for (const part of parts.slice(0, -1)) {
		current = path.join(current, part);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink())
				throw new Error(
					`Refusing to follow symlink during snapshot apply: ${current}`,
				);
			if (!stat.isDirectory())
				throw new Error(`Snapshot path parent is not a directory: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

export function applySnapshot(
	...args: Parameters<typeof applySnapshotUnlocked>
) {
	return withSyncSettingsLocks(() => applySnapshotUnlocked(...args));
}
