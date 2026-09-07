import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	loadConfig,
	localConfigPath,
	readStateForConfig,
	statePathForConfig,
} from "../src/config.js";
import { expectedRemoteHead } from "../src/sync-backend.js";
import {
	PublicationStatePersistenceError,
	pull,
	push,
	status,
	syncBoth,
} from "../src/sync-operations.js";
import type { CommandOptions, Snapshot } from "../src/types.js";
import {
	v3GitSettings as requiredConfig,
	snapshot,
	withTempHome,
} from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

test("fake backend exercises push, pull, and revision state", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const backend = new MemorySyncBackend();
		const factory = () => backend;
		const { ctx, notifications } = createMockContext({ hasUI: true });
		const config = await loadConfig();

		await push(ctx, commandOptions(), undefined, factory);
		const pushed = await backend.readHead();
		assert.ok(pushed);
		assert.equal(
			(await readStateForConfig(config)).lastRemoteRevision,
			pushed.revision,
		);
		const pushedSnapshot = await backend.readSnapshot(pushed.snapshotRef);
		const revisionOnly = await backend.publishSnapshot(
			pushedSnapshot,
			expectedRemoteHead(pushed),
		);
		await status(ctx, commandOptions(), factory);
		assert.match(notifications.at(-1)?.message ?? "", /pi-sync: synced/);
		await syncBoth(ctx, commandOptions(), factory);
		assert.equal(
			(await readStateForConfig(config)).lastRemoteRevision,
			revisionOnly.head.revision,
		);

		const remote = {
			...snapshot([
				{ path: "settings.json", content: Buffer.from('{"remote":true}\n') },
			]),
			id: "remote-change",
		};
		const remoteResult = await backend.publishSnapshot(
			remote,
			expectedRemoteHead(revisionOnly.head),
		);
		await pull(ctx, commandOptions(), factory);
		assert.equal(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
			'{"remote":true}\n',
		);
		assert.equal(
			(await readStateForConfig(config)).lastRemoteRevision,
			remoteResult.head.revision,
		);
	});
});

test("push reports a typed partial outcome when remote commits but local state cannot persist", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const config = await loadConfig();
		const backend = new StateBreakingBackend(statePathForConfig(config));
		const { ctx } = createMockContext({ hasUI: true });

		await assert.rejects(
			push(ctx, commandOptions(), undefined, () => backend),
			(error: unknown) => {
				assert.ok(error instanceof PublicationStatePersistenceError);
				assert.match(
					error.message,
					/remote publication.*active.*state could not be saved/i,
				);
				return true;
			},
		);
		assert.ok(await backend.readHead());
	});
});

test("global setting skips push secret blocking", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			'{"OPENAI_API_KEY":"sk-123456789012345678901234567890"}\n',
		);
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const blockedBackend = new MemorySyncBackend();
		const { ctx } = createMockContext({ hasUI: true });
		await assert.rejects(
			push(ctx, commandOptions(), undefined, () => blockedBackend),
			/Refusing to push possible secrets/u,
		);
		assert.equal(await blockedBackend.readHead(), undefined);

		writeFileSync(
			localConfigPath(),
			JSON.stringify(requiredConfig({ skipSecretScan: true })),
		);
		const allowedBackend = new MemorySyncBackend();
		const allowed = createMockContext({ hasUI: true });
		await push(allowed.ctx, commandOptions(), undefined, () => allowedBackend);
		assert.ok(await allowedBackend.readHead());
	});
});

test("fake backend exercises status and sync", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const backend = new MemorySyncBackend();
		const factory = () => backend;
		const { ctx, notifications } = createMockContext({ hasUI: true });

		await status(ctx, commandOptions(), factory);
		await syncBoth(ctx, commandOptions(), factory);

		const output = notifications.map((item) => item.message).join("\n");
		assert.match(output, /pi-sync: local ahead/);
		assert.match(output, /Pushed 1 files/);
	});
});

test("forced fake-backend push re-reads the head and preserves newly observed unmanaged files", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		writeFileSync(localConfigPath(), JSON.stringify(requiredConfig()));
		const backend = new AdvancingMemoryBackend();
		const initial = {
			...snapshot([
				{ path: "settings.json", content: Buffer.from('{"initial":true}\n') },
			]),
			id: "initial",
		};
		await backend.publishSnapshot(initial, { kind: "missing" });
		backend.arm({
			...snapshot([
				{ path: "settings.json", content: Buffer.from('{"advanced":true}\n') },
				{ path: "AGENTS.md", content: Buffer.from("preserve me\n") },
			]),
			id: "advanced",
		});
		const { ctx } = createMockContext({ hasUI: true });

		await push(
			ctx,
			{ ...commandOptions(), force: true },
			undefined,
			() => backend,
		);

		assert.ok(backend.readCount >= 2);
		const head = await backend.readHead();
		assert.ok(head);
		const published = await backend.readSnapshot(head.snapshotRef);
		assert.deepEqual(published.files.map((file) => file.path).sort(), [
			"AGENTS.md",
			"settings.json",
		]);
	});
});

class StateBreakingBackend extends MemorySyncBackend {
	constructor(private readonly statePath: string) {
		super();
	}

	override async publishSnapshot(
		snapshotValue: Snapshot,
		expected: Parameters<MemorySyncBackend["publishSnapshot"]>[1],
		options?: Parameters<MemorySyncBackend["publishSnapshot"]>[2],
	) {
		const result = await super.publishSnapshot(
			snapshotValue,
			expected,
			options,
		);
		mkdirSync(this.statePath, { recursive: true });
		return result;
	}
}

class AdvancingMemoryBackend extends MemorySyncBackend {
	readCount = 0;
	private advanced?: Snapshot;

	arm(snapshotValue: Snapshot) {
		this.advanced = snapshotValue;
	}

	override async readHead(signal?: AbortSignal) {
		this.readCount += 1;
		if (this.readCount === 2 && this.advanced) {
			const current = await super.readHead(signal);
			await super.publishSnapshot(this.advanced, expectedRemoteHead(current), {
				signal,
			});
			this.advanced = undefined;
		}
		return super.readHead(signal);
	}
}

function _v3SettingsWithBranch(branch: string) {
	const settings = requiredConfig();
	settings.syncSetups.home.storage.branch = branch;
	return settings;
}

function commandOptions(): CommandOptions {
	return {
		yes: true,
		force: false,
		stale: false,
		silent: false,
		reload: false,
		auto: false,
		args: [],
	};
}
