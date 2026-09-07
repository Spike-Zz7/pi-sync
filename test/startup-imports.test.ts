import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { localConfigPath } from "../src/config.js";
import sync, { type SyncDependencies } from "../src/sync-extension.js";
import { v3GitSettings, withTempHome } from "./helpers.js";
import { createMockContext, createMockPi } from "./support.js";

test("lifecycle and rejected legacy commands never load operational modules", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			localConfigPath(),
			JSON.stringify(v3GitSettings({ automatic: true, include: ["sessions"] })),
		);
		const mock = createMockPi();
		const forbidden = async () => {
			throw new Error("must not load");
		};
		sync(mock.pi, {
			loadSetupSwitch: forbidden,
			loadSnapshot: forbidden,
			loadSyncState: forbidden,
			loadSyncOperations: forbidden,
		});
		const { ctx, notifications } = createMockContext({ mode: "rpc" });
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
		assert.deepEqual(notifications, []);
		for (const route of [
			"use home",
			"push",
			"pull",
			"sync",
			"help",
			"init",
			"config",
			"files",
			"doctor",
			"diff",
			"history",
			"rollback old",
			"migrate-state",
			"unlock --stale",
			"--force",
			"status --setup home",
		]) {
			await mock.commands.get("sync")?.handler(route, ctx);
			assert.match(notifications.at(-1)?.message ?? "", /Usage: \/sync setup/);
		}
	});
});

test("operation loading rechecks session cancellation before invoking a route", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()));
		const mock = createMockPi();
		let releaseLoad: (() => void) | undefined;
		let loaded: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			loaded = resolve;
		});
		let statusCalls = 0;
		const operations = {
			status: async () => {
				statusCalls += 1;
			},
		} as unknown as Awaited<ReturnType<SyncDependencies["loadSyncOperations"]>>;
		sync(mock.pi, {
			loadSyncOperations: async () => {
				await new Promise<void>((resolve) => {
					releaseLoad = resolve;
					loaded?.();
				});
				return operations;
			},
		});
		const { ctx } = createMockContext({ mode: "rpc" });
		const pending = mock.commands.get("sync")?.handler("status", ctx);
		await started;
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		releaseLoad?.();
		await pending;
		assert.equal(statusCalls, 0);
	});
});

test("operation loader failure is observable and retries then caches", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()));
		const mock = createMockPi();
		let loads = 0;
		let checks = 0;
		sync(mock.pi, {
			loadSyncOperations: async () => {
				if (++loads === 1) throw new Error("temporary loader failure");
				return {
					status: async () => {
						checks += 1;
					},
				} as unknown as Awaited<
					ReturnType<SyncDependencies["loadSyncOperations"]>
				>;
			},
		});
		const { ctx, notifications } = createMockContext({ mode: "rpc" });
		for (let index = 0; index < 3; index += 1)
			await mock.commands.get("sync")?.handler("status", ctx);
		assert.match(notifications[0]?.message ?? "", /temporary loader failure/);
		assert.equal(loads, 2);
		assert.equal(checks, 2);
	});
});
