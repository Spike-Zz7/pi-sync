import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	loadConfig,
	localConfigPath,
	statePathForConfig,
	writeStateForConfig,
} from "../src/config.js";
import { expectedRemoteHead } from "../src/sync-backend.js";
import { SyncDecisionRequiredError } from "../src/sync-decision.js";
import { pull, push, status, syncBoth } from "../src/sync-operations.js";
import { RemoteSelectionMismatchError } from "../src/sync-policy.js";
import type { CommandOptions, Snapshot } from "../src/types.js";
import { snapshot, v3GitSettings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

const options: CommandOptions = {
	yes: true,
	force: false,
	stale: false,
	silent: false,
	reload: false,
	auto: false,
	args: [],
};

test("sync and pull pause without mutation when remote included content differs", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		const backend = new MemorySyncBackend();
		const remote = {
			...snapshot([
				{ path: "settings.json", content: Buffer.from('{"remote":true}\n') },
				{ path: "pi-starship.toml", content: Buffer.from("remote-only\n") },
			]),
			id: "remote-selection",
			selection: {
				version: 1 as const,
				include: ["settings.json", "pi-starship.toml"],
			},
		};
		await backend.publishSnapshot(remote, { kind: "missing" });
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
		});

		for (const operation of [
			() => syncBoth(ctx, { ...options, auto: true }, () => backend),
			() => pull(ctx, { ...options, force: true }, () => backend),
		]) {
			await assert.rejects(operation(), RemoteSelectionMismatchError);
		}
		await status(ctx, options, () => backend);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/remote included content: differs/i,
		);
		assert.equal(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
			'{"local":true}\n',
		);
		assert.equal(existsSync(path.join(agentDir, "pi-starship.toml")), false);
		assert.equal(existsSync(statePathForConfig(await loadConfig())), false);
	});
});

test("ordinary push checks a differing head policy even when legacy state matches its snapshot", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		const base = Buffer.from('{"base":true}\n');
		writeFileSync(path.join(agentDir, "settings.json"), base);
		const backend = new MemorySyncBackend();
		const remote = {
			...snapshot([
				{ path: "settings.json", content: base },
				{ path: "pi-starship.toml", content: Buffer.from("remote-only\n") },
			]),
			id: "remote-selection",
			selection: {
				version: 1 as const,
				include: ["settings.json", "pi-starship.toml"],
			},
		};
		const published = await backend.publishSnapshot(remote, {
			kind: "missing",
		});
		const config = await loadConfig();
		await writeStateForConfig(config, {
			version: 1,
			profile: config.snapshotIdentity,
			lastAppliedSnapshot: remote.id,
			lastRemoteRevision: published.head.revision,
			lastFileHashes: { "settings.json": remote.files[0]?.sha256 ?? "" },
			include: ["settings.json"],
		});
		writeFileSync(path.join(agentDir, "settings.json"), '{"changed":true}\n');
		const headBefore = await backend.readHead();
		const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

		await assert.rejects(
			push(ctx, options, undefined, () => backend),
			RemoteSelectionMismatchError,
		);
		assert.equal((await backend.readHead())?.revision, headBefore?.revision);
		assert.deepEqual(
			(await backend.readSnapshot(remote.id)).selection,
			remote.selection,
		);
	});
});

test("reviewed force push keeps local selection and preserves remote unmanaged files", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		const backend = new MemorySyncBackend();
		await backend.publishSnapshot(
			{
				...snapshot([
					{ path: "settings.json", content: Buffer.from('{"remote":true}\n') },
					{ path: "pi-starship.toml", content: Buffer.from("preserved\n") },
				]),
				id: "remote-selection",
				selection: {
					version: 1,
					include: ["settings.json", "pi-starship.toml"],
				},
			},
			{ kind: "missing" },
		);
		const reviews: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			confirm: async (_title: string, message: string) => {
				reviews.push(message);
				return true;
			},
		});

		await push(
			ctx,
			{ ...options, yes: false, force: true },
			undefined,
			() => backend,
		);
		const head = await backend.readHead();
		assert.ok(head);
		const published = await backend.readSnapshot(head.snapshotRef);
		assert.deepEqual(published.selection, {
			version: 1,
			include: ["settings.json"],
		});
		assert.match(reviews.join("\n"), /replace the differing remote selection/i);
		assert.deepEqual(published.files.map((file) => file.path).sort(), [
			"pi-starship.toml",
			"settings.json",
		]);
	});
});

test("refreshed force push re-scans secrets and rejects preserved remote secrets", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		const backend = new MemorySyncBackend();
		await backend.publishSnapshot(
			{
				...snapshot([
					{ path: "settings.json", content: Buffer.from('{"remote":true}\n') },
					{ path: "pi-starship.toml", content: Buffer.from("clean\n") },
				]),
				id: "remote-1",
				selection: {
					version: 1,
					include: ["settings.json", "pi-starship.toml"],
				},
			},
			{ kind: "missing" },
		);
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			confirm: async () => {
				await backend.publishSnapshot(
					{
						...snapshot([
							{
								path: "settings.json",
								content: Buffer.from('{"remote":true}\n'),
							},
							{
								path: "pi-starship.toml",
								content: Buffer.from(
									"ANTHROPIC_API_KEY=sk-ant-api03-123456789012345678901234567890\n",
								),
							},
						]),
						id: "remote-2",
						selection: {
							version: 1,
							include: ["settings.json", "pi-starship.toml"],
						},
					},
					{
						kind: "revision",
						revision: (await backend.readHead())?.revision ?? "missing",
					},
				);
				return true;
			},
		});

		await assert.rejects(
			push(
				ctx,
				{ ...options, yes: false, force: true },
				undefined,
				() => backend,
			),
			/Refusing to push possible secrets/i,
		);
	});
});

test("push reports a structured remote-or-policy decision without mutation", async () => {
	await withInitializedSync(async ({ agentDir, backend, config }) => {
		writeFileSync(
			path.join(agentDir, "settings.json"),
			'{"local":"changed"}\n',
		);
		writeFileSync(path.join(agentDir, "AGENTS.md"), "local policy addition\n");
		writeFileSync(
			localConfigPath(),
			JSON.stringify(
				v3GitSettings({ include: ["settings.json", "AGENTS.md"] }),
			),
			{ mode: 0o600 },
		);
		const remote = namedSnapshot("remote-change", '{"remote":"changed"}\n');
		await backend.publishSnapshot(
			remote,
			expectedRemoteHead(await backend.readHead()),
		);
		const headBefore = await backend.readHead();

		await assert.rejects(pushContext(backend), (error: unknown) => {
			assert.ok(error instanceof SyncDecisionRequiredError);
			assert.equal(error.decision.kind, "remote-or-policy-changed");
			assert.equal(error.decision.setupName, "home");
			assert.deepEqual(error.decision.directions, ["push", "pull"]);
			assert.equal(error.decision.causes.localChanged, true);
			assert.equal(error.decision.causes.remoteChanged, true);
			assert.equal(error.decision.causes.policyChanged, true);
			assert.deepEqual(error.decision.previousInclude, ["settings.json"]);
			assert.deepEqual(error.decision.currentInclude, [
				"settings.json",
				"AGENTS.md",
			]);
			assert.match(error.decision.review, /Different: settings\.json/u);
			return true;
		});
		assert.equal((await backend.readHead())?.revision, headBefore?.revision);
		assert.equal(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
			'{"local":"changed"}\n',
		);
		assert.equal(existsSync(statePathForConfig(config)), true);
	});
});

test("pull and Sync now report structured both-changed decisions without mutation", async () => {
	await withInitializedSync(async ({ agentDir, backend }) => {
		writeFileSync(
			path.join(agentDir, "settings.json"),
			'{"local":"changed"}\n',
		);
		const remote = namedSnapshot("remote-change", '{"remote":"changed"}\n');
		await backend.publishSnapshot(
			remote,
			expectedRemoteHead(await backend.readHead()),
		);
		const { ctx } = createMockContext({ hasUI: true, mode: "tui" });
		for (const operation of [pull, syncBoth]) {
			await assert.rejects(
				operation(ctx, options, () => backend),
				(error: unknown) => {
					assert.ok(error instanceof SyncDecisionRequiredError);
					assert.equal(error.decision.kind, "both-changed");
					assert.deepEqual(error.decision.directions, ["push", "pull"]);
					assert.match(error.decision.review, /Different: settings\.json/u);
					return true;
				},
			);
		}
		assert.equal(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
			'{"local":"changed"}\n',
		);
		assert.equal((await backend.readHead())?.snapshotId, "remote-change");
	});
});

test("forced pull reuses backup and apply safeguards after a decision", async () => {
	await withInitializedSync(async ({ agentDir, backend }) => {
		writeFileSync(
			path.join(agentDir, "settings.json"),
			'{"local":"changed"}\n',
		);
		const remote = namedSnapshot("remote-change", '{"remote":"changed"}\n');
		await backend.publishSnapshot(
			remote,
			expectedRemoteHead(await backend.readHead()),
		);
		const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

		const outcome = await pull(ctx, { ...options, force: true }, () => backend);
		assert.equal(outcome, "applied");
		assert.equal(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
			'{"remote":"changed"}\n',
		);
		assert.ok(
			readdirSync(path.join(agentDir, "pi-sync", "backups")).length > 0,
		);
	});
});

test("forced push still refuses secrets after a decision", async () => {
	await withInitializedSync(async ({ agentDir, backend }) => {
		writeFileSync(
			path.join(agentDir, "settings.json"),
			'{"note":"OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456"}\n',
		);
		const remote = namedSnapshot("remote-change", '{"remote":"changed"}\n');
		await backend.publishSnapshot(
			remote,
			expectedRemoteHead(await backend.readHead()),
		);
		const headBefore = await backend.readHead();
		const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

		await assert.rejects(
			push(ctx, { ...options, force: true }, undefined, () => backend),
			/Refusing to push possible secrets/u,
		);
		assert.equal((await backend.readHead())?.revision, headBefore?.revision);
	});
});

test("first sync reports different settings as an initial-source decision", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		const backend = new MemorySyncBackend();
		await backend.publishSnapshot(
			namedSnapshot("remote", '{"remote":true}\n'),
			{
				kind: "missing",
			},
		);
		const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

		await assert.rejects(
			syncBoth(ctx, options, () => backend),
			(error: unknown) => {
				assert.ok(error instanceof SyncDecisionRequiredError);
				assert.equal(error.decision.kind, "first-sync-settings-diverged");
				assert.match(error.decision.review, /first sync/u);
				return true;
			},
		);
		assert.equal(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
			'{"local":true}\n',
		);
		assert.equal(existsSync(statePathForConfig(await loadConfig())), false);
	});
});

test("first sync reports different sessions as an initial-source decision", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
		writeFileSync(
			localConfigPath(),
			JSON.stringify(v3GitSettings({ include: ["settings.json", "sessions"] })),
			{ mode: 0o600 },
		);
		writeFileSync(path.join(agentDir, "settings.json"), '{"same":true}\n');
		writeFileSync(
			path.join(agentDir, "sessions", "one.jsonl"),
			'{"local":true}\n',
		);
		const backend = new MemorySyncBackend();
		const remote = snapshot([
			{ path: "settings.json", content: Buffer.from('{"same":true}\n') },
			{ path: "sessions/one.jsonl", content: Buffer.from('{"remote":true}\n') },
		]);
		await backend.publishSnapshot(
			{ ...remote, id: "remote", syncSessions: true },
			{ kind: "missing" },
		);
		const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

		await assert.rejects(
			syncBoth(ctx, options, () => backend),
			(error: unknown) => {
				assert.ok(error instanceof SyncDecisionRequiredError);
				assert.equal(error.decision.kind, "first-sync-sessions-diverged");
				assert.match(error.decision.review, /sessions differ/u);
				return true;
			},
		);
		assert.equal(
			readFileSync(path.join(agentDir, "sessions", "one.jsonl"), "utf8"),
			'{"local":true}\n',
		);
	});
});

test("push reports confirmation cancellation without publishing", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		const backend = new MemorySyncBackend();
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			confirm: async () => false,
		});

		assert.equal(
			await push(ctx, { ...options, yes: false }, undefined, () => backend),
			"cancelled",
		);
		assert.equal(await backend.readHead(), undefined);
	});
});

test("pull from an empty remote offers only a structured push decision", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		writeFileSync(path.join(agentDir, "settings.json"), '{"local":true}\n');
		const backend = new MemorySyncBackend();
		const { ctx } = createMockContext({ hasUI: true, mode: "tui" });

		await assert.rejects(
			pull(ctx, options, () => backend),
			(error: unknown) => {
				assert.ok(error instanceof SyncDecisionRequiredError);
				assert.equal(error.decision.kind, "remote-empty");
				assert.deepEqual(error.decision.directions, ["push"]);
				assert.match(error.decision.review, /Add: settings\.json/u);
				return true;
			},
		);
		assert.equal(await backend.readHead(), undefined);
	});
});

async function withInitializedSync(
	run: (state: {
		agentDir: string;
		backend: MemorySyncBackend;
		config: Awaited<ReturnType<typeof loadConfig>>;
	}) => Promise<void>,
) {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		writeFileSync(path.join(agentDir, "settings.json"), '{"base":true}\n');
		const backend = new MemorySyncBackend();
		const { ctx } = createMockContext({ hasUI: true, mode: "tui" });
		await push(ctx, options, undefined, () => backend);
		await run({ agentDir, backend, config: await loadConfig() });
	});
}

function pushContext(backend: MemorySyncBackend) {
	const { ctx } = createMockContext({ hasUI: true, mode: "tui" });
	return push(ctx, options, undefined, () => backend);
}

function namedSnapshot(id: string, content: string): Snapshot {
	return {
		...snapshot([{ path: "settings.json", content: Buffer.from(content) }]),
		id,
	};
}
