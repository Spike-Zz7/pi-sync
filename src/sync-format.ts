import { agentDir } from "./config.js";
import { isStaleLock, type LockInspection } from "./lock.js";
import { errorMessage } from "./manager-helpers.js";

export { errorMessage } from "./manager-helpers.js";

import type {
	BackendDiagnostic,
	PublicationCapability,
	RemoteHead,
	SyncBackend,
} from "./sync-backend.js";
import {
	compareSyncInclude,
	formatRemoteSelectionStatus,
	inspectRemoteSelection,
	type RemoteSelectionDecision,
	type RemoteSelectionState,
} from "./sync-policy.js";
import { fileHashMap } from "./sync-state.js";
import type { CommonSyncConfig, Snapshot, SyncState } from "./types.js";

export function formatDiff(local: Snapshot, remote: Snapshot) {
	const localMap = fileHashMap(local);
	const remoteMap = fileHashMap(remote);
	const allPaths = [
		...new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]),
	].sort();
	const lines = [
		`local: ${local.files.length} files`,
		`remote: ${remote.id} (${remote.files.length} files)`,
		"",
	];
	let changed = 0;
	for (const filePath of allPaths) {
		if (!localMap[filePath]) {
			lines.push(`Remote only: ${filePath}`);
			changed += 1;
		} else if (!remoteMap[filePath]) {
			lines.push(`Local only: ${filePath}`);
			changed += 1;
		} else if (localMap[filePath] !== remoteMap[filePath]) {
			lines.push(`Different: ${filePath}`);
			changed += 1;
		}
	}
	if (changed === 0) lines.push("No file differences.");
	return lines.join("\n");
}

export function formatSnapshotOnlyDiff(title: string, snapshot: Snapshot) {
	return [
		`${title}: ${snapshot.id}`,
		...snapshot.files.map((file) => `Add: ${file.path}`),
	].join("\n");
}

export function formatPushSummary(
	config: CommonSyncConfig,
	destination: string,
	upload: Snapshot,
	head: RemoteHead | undefined,
	preservedRemoteFileCount = 0,
	remote?: Snapshot,
) {
	return [
		`Sync setup: ${safeTerminalText(config.setupName)}`,
		`Storage location: ${safeTerminalText(destination)}`,
		`Upload ${upload.files.length} files from ${safeTerminalText(agentDir())}.`,
		`Sessions: ${upload.syncSessions ? "included — may contain private conversations" : "not included"}`,
		head ? `Remote latest: ${head.snapshotId}` : "Remote latest: empty",
		"Publication effect: the backend's active head will reference the new immutable snapshot.",
		...(remote &&
		inspectRemoteSelection(config.include, remote).kind === "different"
			? [
					"Included-content policy effect: replace the differing remote selection with this setup's local selection.",
				]
			: []),
		formatPublicationPreview(remote, upload),
		preservedRemoteFileCount > 0
			? `Possible secrets in locally managed files were scanned before this prompt; ${preservedRemoteFileCount} preserved remote file(s) were not rescanned.`
			: "Possible secrets were scanned before this prompt.",
	].join("\n");
}

export function formatApplyPreview(local: Snapshot, remote: Snapshot) {
	return formatDirectionalChanges(local, remote, {
		add: "Add locally",
		update: "Update locally",
		remove: "Remove locally",
	});
}

export function formatPullSummary(
	config: CommonSyncConfig,
	destination: string,
	local: Snapshot,
	remote: Snapshot,
	protectedSessionCount: number,
) {
	return [
		`Sync setup: ${safeTerminalText(config.setupName)}`,
		`Storage location: ${safeTerminalText(destination)}`,
		`Snapshot: ${safeTerminalText(remote.id)}`,
		`Sessions: ${remote.syncSessions ? "included — may contain private conversations" : "not included"}`,
		`Protected live sessions: ${protectedSessionCount || "none"}`,
		formatApplyPreview(local, remote),
		"A local backup is created before these writes/deletes. The remote active snapshot is unchanged.",
	].join("\n");
}

export function formatRollbackSummary(
	config: CommonSyncConfig,
	destination: string,
	local: Snapshot,
	remote: Snapshot,
	requestedSnapshot: string,
	protectedSessionCount: number,
) {
	return [
		`Sync setup: ${safeTerminalText(config.setupName)}`,
		`Storage location: ${safeTerminalText(destination)}`,
		`Snapshot: ${safeTerminalText(requestedSnapshot)}`,
		`Sessions: ${remote.syncSessions ? "included — may contain private conversations" : "not included"}`,
		`Protected live sessions: ${protectedSessionCount || "none"}`,
		formatApplyPreview(local, remote),
		"A local backup is created before applying; the backend's active head will change.",
	].join("\n");
}

function formatPublicationPreview(
	remote: Snapshot | undefined,
	upload: Snapshot,
) {
	if (!remote) {
		return [
			"Remote is empty.",
			...upload.files.map((file) => `Add remotely: ${file.path}`),
		].join("\n");
	}
	return formatDirectionalChanges(remote, upload, {
		add: "Add remotely",
		update: "Update remotely",
		remove: "Remove remotely",
	});
}

function formatDirectionalChanges(
	before: Snapshot,
	after: Snapshot,
	labels: { add: string; update: string; remove: string },
) {
	const beforeMap = fileHashMap(before);
	const afterMap = fileHashMap(after);
	const paths = [
		...new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)]),
	].sort();
	const lines: string[] = [];
	for (const filePath of paths) {
		if (!beforeMap[filePath]) lines.push(`${labels.add}: ${filePath}`);
		else if (!afterMap[filePath]) lines.push(`${labels.remove}: ${filePath}`);
		else if (beforeMap[filePath] !== afterMap[filePath])
			lines.push(`${labels.update}: ${filePath}`);
	}
	if (lines.length === 0) lines.push("No file changes.");
	return lines.join("\n");
}

export function countPreservedRemoteFiles(local: Snapshot, upload: Snapshot) {
	const localPaths = new Set(local.files.map((file) => file.path));
	return upload.files.filter((file) => !localPaths.has(file.path)).length;
}

export function publicationCapabilityDescription(
	capability: PublicationCapability,
) {
	switch (capability) {
		case "lease-protected":
			return "lease-protected (exact expected-ref update)";
		case "atomic-conditional":
			return "atomic-conditional (verified atomic precondition)";
	}
}

export function safeTerminalText(value: string) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}

export function redact(value: string) {
	return value.length <= 8
		? "configured"
		: `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function formatStatusSummary(
	config: CommonSyncConfig,
	backend: Pick<SyncBackend, "destination" | "capability">,
	local: Snapshot,
	_state: SyncState,
	head: RemoteHead | undefined,
	selectionState: RemoteSelectionState | undefined,
	localChanged: boolean,
	remoteChanged: boolean,
	warnings: readonly string[] = [],
): { text: string; level: "info" | "warning" } {
	const remoteText = head
		? `remote: ${head.snapshotId} from ${head.machine} at ${head.createdAt}`
		: "remote: empty";
	const level =
		localChanged ||
		remoteChanged ||
		selectionState?.kind === "different" ||
		warnings.length > 0
			? "warning"
			: "info";
	const text = [
		`sync setup: ${config.setupName}`,
		`storage connection: ${config.connectionName}`,
		`storage location: ${safeTerminalText(backend.destination)}`,
		`publication safety: ${publicationCapabilityDescription(backend.capability)}`,
		`included content: ${config.include.join(", ") || "none"}`,
		`sessions: ${config.include.includes("sessions") ? "included" : "excluded"}`,
		remoteText,
		formatRemoteSelectionStatus(selectionState),
		`local files: ${local.files.length}`,
		`local changed since last sync: ${localChanged ? "yes" : "no"}`,
		`remote changed since last sync: ${remoteChanged ? "yes" : "no"}`,
		...warnings,
	].join("\n");
	return { text, level };
}

export function formatDoctorMessages(
	config: CommonSyncConfig | undefined,
	backend: SyncBackend | undefined,
	local: Snapshot | undefined,
	secrets: readonly string[],
	lock: LockInspection | undefined,
	guardHeld: boolean,
	warnings: readonly string[] = [],
	error?: unknown,
	diagnostics: readonly BackendDiagnostic[] = [],
): { messages: string[]; text: string; level: "info" | "warning" } {
	const messages: string[] = [];
	let level: "info" | "warning" = "info";

	if (config) {
		messages.push(
			`config: ok (sync setup ${config.setupName})`,
			`included content: ${config.include.join(", ") || "none"}`,
			`sessions: ${config.include.includes("sessions") ? "included" : "excluded"}`,
		);
		if (warnings.length > 0) {
			level = "warning";
			messages.push(...warnings);
		}
	} else if (error) {
		level = "warning";
		messages.push(`config: ${errorMessage(error)}`);
	}

	if (local) {
		if (secrets.length > 0) {
			level = "warning";
			messages.push("secret scan: possible secrets found:");
			messages.push(...secrets.map((secret) => `- ${secret}`));
		} else {
			messages.push(`secret scan: ok (${local.files.length} files checked)`);
		}
	}

	if (lock?.status === "valid" && isStaleLock(lock.lock)) {
		level = "warning";
		messages.push(
			`lock: stale (pid ${lock.lock.pid}); run /sync unlock after verifying no sync is running`,
		);
	} else if (lock?.status === "valid") {
		messages.push(
			`lock: held by pid ${lock.lock.pid} since ${lock.lock.startedAt}`,
		);
	} else if (lock?.status === "unreadable") {
		level = "warning";
		messages.push(
			"lock: unreadable; use /sync unlock --stale only after verifying no sync is running",
		);
	} else if (guardHeld) {
		level = "warning";
		messages.push(
			"lock: guard active while metadata is missing or still being initialized",
		);
	} else if (lock) {
		messages.push("lock: free");
	}

	if (backend) {
		messages.push(
			`storage location: ${safeTerminalText(backend.destination)}`,
			`publication safety: ${publicationCapabilityDescription(backend.capability)}`,
		);
		for (const diagnostic of diagnostics) {
			messages.push(diagnostic.message);
			if (diagnostic.level !== "info") level = "warning";
		}
	}

	return { messages, text: messages.join("\n"), level };
}

export function formatDiffSummary(
	config: CommonSyncConfig,
	backend: Pick<SyncBackend, "destination">,
	local: Snapshot,
	remote: Snapshot | undefined,
	selectionState: RemoteSelectionState | undefined,
	warnings: readonly string[] = [],
): { text: string; level: "info" | "warning" } {
	const header = [
		`sync setup: ${config.setupName}`,
		`storage connection: ${config.connectionName}`,
		`storage location: ${safeTerminalText(backend.destination)}`,
		`included content: ${config.include.join(", ") || "none"}`,
		`sessions: ${config.include.includes("sessions") ? "included" : "excluded"}`,
		formatRemoteSelectionStatus(selectionState),
		...warnings,
	].join("\n");
	const level =
		warnings.length > 0 || selectionState?.kind === "different"
			? "warning"
			: "info";
	const diffBody = !remote
		? formatSnapshotOnlyDiff("Remote is empty. Local push would upload", local)
		: formatDiff(local, remote);
	return { text: `${header}\n\n${diffBody}`, level };
}

export function formatPolicyChangeDetails(decision: RemoteSelectionDecision) {
	const diff = compareSyncInclude(
		decision.localInclude,
		decision.remoteInclude,
	);
	return {
		diff,
		orderOnly: diff.remoteOnly.length === 0 && diff.localOnly.length === 0,
	};
}

function formatPrefixedList(items: readonly string[], prefix: string) {
	return items.length > 0
		? items.map((item) => `${prefix} ${safeTerminalText(item)}`)
		: ["(none)"];
}

function formatNumberedList(items: readonly string[]) {
	return items.length > 0
		? items.map((item, index) => `${index + 1}. ${safeTerminalText(item)}`)
		: ["(none)"];
}

export function selectionSummaryLines(
	decision: RemoteSelectionDecision,
	details = formatPolicyChangeDetails(decision),
) {
	return [
		`Sync setup: ${safeTerminalText(decision.setupName)}`,
		"Nothing changed. Review both lists before choosing what happens next.",
		details.orderOnly
			? "Only the ordering differs; membership is the same."
			: `Remote-only paths: ${details.diff.remoteOnly.length} · Device-only paths: ${details.diff.localOnly.length}`,
	];
}

export function formatSelectionDifference(
	decision: RemoteSelectionDecision,
	details = formatPolicyChangeDetails(decision),
	_mode?: "review" | "diff",
) {
	return [
		...(details.orderOnly
			? ["Only ordering differs; both lists contain the same paths.", ""]
			: []),
		"Remote-only paths:",
		...formatPrefixedList(details.diff.remoteOnly, "+"),
		"",
		"Device-only paths:",
		...formatPrefixedList(details.diff.localOnly, "-"),
		"",
		"Remote ordered list:",
		...formatNumberedList(decision.remoteInclude),
		"",
		"This device's ordered list:",
		...formatNumberedList(decision.localInclude),
		"",
		"Using the remote list saves settings only and does not pull files.",
	].join("\n");
}

export function formatRemoteSelectionSummary(
	decision: RemoteSelectionDecision,
	details = formatPolicyChangeDetails(decision),
) {
	const safeList = (values: readonly string[]) =>
		values.length > 0 ? values.map(safeTerminalText).join(", ") : "none";
	return [
		`Synced content for “${safeTerminalText(decision.setupName)}” differs from this device.`,
		`Remote-only: ${safeList(details.diff.remoteOnly)}`,
		`Device-only: ${safeList(details.diff.localOnly)}`,
		...(details.orderOnly
			? [
					"Only ordering differs.",
					`Remote order: ${safeList(decision.remoteInclude)}`,
					`Device order: ${safeList(decision.localInclude)}`,
				]
			: []),
		"Run /sync in TUI to choose a content list; RPC review is read-only.",
	].join("\n");
}

export function formatLegacySummary(
	config: Pick<CommonSyncConfig, "setupName">,
	discovered: readonly string[],
) {
	return `Remote snapshot for “${safeTerminalText(config.setupName)}” has no portable synced-content list; ${discovered.length} safe path${discovered.length === 1 ? " was" : "s were"} discovered, but the result is partial and read-only.`;
}

export function formatSnapshotHistoryLabel(
	item: {
		createdAt: string;
		machine: string;
		snapshotId: string;
		syncSessions?: boolean;
	},
	isCurrent: boolean,
) {
	return `${item.createdAt} · ${safeTerminalText(item.machine)} · ${item.snapshotId}${isCurrent ? " (current)" : ""}${item.syncSessions ? " · sessions" : ""}`;
}

export function continueLabel(origin: "settings" | "sync" | "pull" | "push") {
	return origin === "pull"
		? "Continue Pull now…"
		: origin === "push"
			? "Continue Push now…"
			: "Continue Sync now…";
}

export function continueBusyLabel(
	origin: "settings" | "sync" | "pull" | "push",
) {
	return origin === "pull"
		? "Checking remote changes…"
		: origin === "push"
			? "Preparing push preview…"
			: "Checking current sync setup…";
}

export function continuationCancelledMessage(route: "sync" | "pull" | "push") {
	return route === "pull"
		? "Pull check cancelled; no local files were changed."
		: route === "push"
			? "Push preparation cancelled; no remote files were changed."
			: "Sync check cancelled; no settings or files were changed.";
}
