import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadConfig, localConfigPath } from "../src/config.js";
import { showSyncManager, showSyncSetups } from "../src/manager-ui.js";
import { saveOnSwitch, useSyncSetup } from "../src/setup-switch.js";
import { v3GitSettings, withTempHome } from "./helpers.js";

for (const remote of [
	"git@github.com:owner/a.git",
	"git@github.com:owner/b.git",
]) {
	test(`saved Git setup detail exposes the exact remote ${remote} without writes`, async () => {
		await withTempHome(async (agentDir) => {
			mkdirSync(agentDir, { recursive: true });
			const settings = v3GitSettings();
			Object.assign(settings.storageConnections, {
				git: {
					type: "git",
					remote,
				},
			});
			Object.assign(settings.syncSetups, {
				work: {
					storage: { connection: "git", branch: "main", path: "pi-sync/work" },
					sync: { include: ["settings.json"], automatic: false },
				},
			});
			const before = JSON.stringify(settings);
			writeFileSync(localConfigPath(), before, { mode: 0o600 });

			const choices = ["More…", "Sync setups…", "work"];
			const frames: string[] = [];
			const routes: string[] = [];
			const { ctx, notifications } = createMockContext({
				hasUI: true,
				mode: "rpc",
				select: async (title: string) => {
					frames.push(title);
					return choices.shift();
				},
			});
			await showSyncManager(ctx, async (route) => {
				routes.push(route);
			});
			assert.ok(frames.some((frame) => frame.includes(`Endpoint: ${remote}`)));
			assert.ok(
				frames.some((frame) =>
					frame.includes("Storage location: Git · main:pi-sync/work"),
				),
			);
			assert.deepEqual(routes, []);
			assert.deepEqual(notifications, []);
			assert.equal(readFileSync(localConfigPath(), "utf8"), before);
		});
	});
}

for (const originalPolicy of [
	"switch-only",
	"ask-before-pull",
	"pull-after-switch",
]) {
	test(`switch-only selection replaces ${originalPolicy} without pulling`, async () => {
		await withTempHome(async (agentDir) => {
			mkdirSync(agentDir, { recursive: true });
			const settings = v3GitSettings();
			settings.onSwitch = originalPolicy;
			Object.assign(settings.syncSetups, {
				work: {
					storage: {
						connection: "origin",
						branch: "main",
						path: "pi-sync/work",
					},
					sync: { include: ["settings.json"], automatic: false },
				},
			});
			writeFileSync(localConfigPath(), JSON.stringify(settings), {
				mode: 0o600,
			});
			assert.equal((await loadConfig()).setupName, "home");
			assert.equal((await loadConfig("work")).setupName, "work");
			const { ctx, notifications } = createMockContext({
				hasUI: true,
				mode: "rpc",
			});
			await saveOnSwitch("switch-only");
			let pulls = 0;
			await useSyncSetup(ctx, "work", async () => {
				pulls += 1;
				return "applied";
			});
			assert.equal(pulls, 0);
			assert.equal((await loadConfig()).setupName, "work");
			const { default: sync } = await import("../src/sync.js");
			const mock = createMockPi();
			sync(mock.pi);
			await mock.commands.get("sync")?.handler("config", ctx);
			assert.ok(
				notifications.some(({ message }) =>
					message.includes("sync setup: work"),
				),
			);
			const selections: string[][] = [];
			const menuContext = createMockContext({
				hasUI: true,
				mode: "rpc",
				select: async (_title: string, options: string[]) => {
					selections.push(options);
					return undefined;
				},
			});
			await showSyncSetups(menuContext.ctx, {
				add: async () => undefined,
				edit: async () => undefined,
				makeCurrent: async () => undefined,
				remove: async () => undefined,
			});
			assert.ok(selections[0]?.includes("work (current)"));
		});
	});
}
