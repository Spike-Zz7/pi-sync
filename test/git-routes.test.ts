import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { localConfigPath } from "../src/config.js";
import { GitSyncBackend } from "../src/git-backend.js";
import syncExtension from "../src/sync.js";
import { expectedRemoteHead } from "../src/sync-backend.js";
import { pull, push, status, syncBoth } from "../src/sync-operations.js";
import type { CommandOptions, ResolvedGitBackend } from "../src/types.js";
import { createBareRemote } from "./git-test-helpers.js";
import { v3GitSettings, withEnv, withTempHome } from "./helpers.js";

function options(args: string[] = []): CommandOptions {
	return {
		yes: true,
		force: false,
		stale: false,
		silent: false,
		reload: false,
		auto: false,
		args,
	};
}

test("all backend-neutral sync routes operate against a Git target", async () => {
	const fixture = createBareRemote();
	try {
		await withEnv(
			{
				PI_SYNC_ACCESS_KEY_ID: "ignored-access",
				PI_SYNC_SECRET_ACCESS_KEY: "ignored-secret",
				PI_SYNC_SESSIONS: "true",
			},
			() =>
				withTempHome(async (agentDir) => {
					mkdirSync(agentDir, { recursive: true });
					writeFileSync(
						path.join(agentDir, "settings.json"),
						'{"theme":"dark"}\n',
					);
					writeFileSync(
						localConfigPath(),
						JSON.stringify({
							version: 3,
							activeSyncSetup: "home",
							onSwitch: "ask-before-pull",
							storageConnections: {
								github: {
									type: "git",
									remote: "ssh://git@example.com/private/pi-sync.git",
								},
							},
							syncSetups: {
								home: {
									storage: {
										connection: "github",
										branch: "pi-sync/home",
										path: "pi-sync/home",
									},
									sync: { include: ["settings.json"], automatic: true },
								},
							},
						}),
					);
					const backendConfig: ResolvedGitBackend = {
						type: "git",
						profile: { kind: "git", remote: fixture.remote },
						destination: {
							branch: "pi-sync/home",
							directory: "pi-sync/home",
							namespace: "home",
						},
					};
					const backend = new GitSyncBackend(backendConfig, {
						cacheRoot: path.join(fixture.root, "cache"),
						allowLocalRemotes: true,
					});
					const factory = () => backend;
					const { ctx, notifications } = createMockContext({ hasUI: true });

					await status(ctx, options(), factory);
					await push(ctx, options(), undefined, factory);
					const first = await backend.readHead();
					assert.ok(first);
					writeFileSync(
						path.join(agentDir, "settings.json"),
						'{"theme":"light"}\n',
					);
					await pull(ctx, { ...options(), force: true }, factory);
					assert.equal(
						readFileSync(path.join(agentDir, "settings.json"), "utf8"),
						'{"theme":"dark"}\n',
					);
					await syncBoth(ctx, options(), factory);

					const mock = createMockPi();
					syncExtension(mock.pi, {
						loadSyncOperations: async () => ({
							...(await import("../src/sync-operations.js")),
							status: (context, opts) => status(context, opts, factory),
						}),
					});
					await mock.commands
						.get("sync")
						?.handler("status", { ...ctx, mode: "rpc" });
					const configOutput = notifications.at(-1)?.message ?? "";
					assert.match(configOutput, /pi-sync: synced/);
					assert.match(configOutput, /Branch: pi-sync\/home/);
					assert.doesNotMatch(
						configOutput,
						/password|accessKeyId|secretAccessKey/i,
					);
					const output = notifications.map((item) => item.message).join("\n");
					assert.doesNotMatch(output, /PI_SYNC_|ignored-access|ignored-secret/);
				}),
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("public sync automatically commits Git changes, propagates deletions and status never publishes", async () => {
	const fixture = createBareRemote();
	try {
		await withTempHome(async (agentDir) => {
			mkdirSync(agentDir, { recursive: true });
			const settings = v3GitSettings({
				include: ["preferences.txt", "snippets"],
				path: "./",
			});
			writeFileSync(localConfigPath(), JSON.stringify(settings));
			writeFileSync(path.join(agentDir, "preferences.txt"), "base");
			mkdirSync(path.join(agentDir, "snippets"));
			writeFileSync(path.join(agentDir, "snippets/only.txt"), "keep");
			const backend = new GitSyncBackend(
				{
					type: "git",
					profile: { kind: "git", remote: fixture.remote },
					destination: { branch: "main", directory: "./", namespace: "root" },
				},
				{
					cacheRoot: path.join(fixture.root, "cache"),
					allowLocalRemotes: true,
				},
			);
			const mock = createMockPi();
			syncExtension(mock.pi, {
				loadSyncOperations: async () => ({
					...(await import("../src/sync-operations.js")),
					syncBoth: (context, opts) => syncBoth(context, opts, () => backend),
					status: (context, opts) => status(context, opts, () => backend),
				}),
			});
			const { ctx, notifications } = createMockContext({
				mode: "rpc",
				confirm: async () => {
					throw new Error("No direction confirmation expected");
				},
			});
			const run = (route = "") =>
				mock.commands.get("sync")?.handler(route, ctx);
			await run();
			const first = await backend.readHead();
			assert.ok(first, notifications.map(({ message }) => message).join("\n"));
			assert.equal(
				execFileSync(
					"git",
					["--git-dir", fixture.remote, "rev-list", "--count", "main"],
					{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
				).trim(),
				"1",
			);
			writeFileSync(path.join(agentDir, "preferences.txt"), "changed");
			rmSync(path.join(agentDir, "snippets/only.txt"));
			await run("status");
			assert.match(notifications.at(-1)?.message ?? "", /local ahead/);
			assert.equal((await backend.readHead())?.revision, first.revision);
			await run();
			const second = await backend.readHead();
			assert.ok(second);
			assert.notEqual(second.revision, first.revision);
			const uploaded = await backend.readSnapshot(second.snapshotRef);
			assert.deepEqual(
				uploaded.files.map(({ path: filePath }) => filePath),
				["preferences.txt"],
			);
			assert.equal(
				execFileSync(
					"git",
					["--git-dir", fixture.remote, "rev-list", "--count", "main"],
					{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
				).trim(),
				"2",
			);
			await backend.publishSnapshot(
				{ ...uploaded, id: "remote-delete", files: [] },
				expectedRemoteHead(second),
			);
			const remote = await backend.readHead();
			await run("status");
			assert.match(notifications.at(-1)?.message ?? "", /remote ahead/);
			assert.equal(
				readFileSync(path.join(agentDir, "preferences.txt"), "utf8"),
				"changed",
			);
			await run();
			assert.equal(existsSync(path.join(agentDir, "preferences.txt")), false);
			assert.deepEqual(await backend.readHead(), remote);
			await run();
			assert.deepEqual(await backend.readHead(), remote);
			assert.match(notifications.at(-1)?.message ?? "", /synced/);
		});
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
