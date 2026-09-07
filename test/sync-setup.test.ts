import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
	localConfigPath,
	readLocalConfigObject,
	updateLocalConfig,
} from "../src/config.js";
import { loadSingleTargetSetup } from "../src/single-target.js";
import sync from "../src/sync-extension.js";
import { prepareSyncSetup, showSyncSetup } from "../src/sync-setup.js";
import { v3GitSettings, withTempHome } from "./helpers.js";
import { createMockContext, createMockPi } from "./support.js";

initTheme("dark", false);

function setupContext(
	confirm = true,
	remote = "git@github.com:example/new.git",
) {
	const reviews: string[] = [];
	const prompts: string[] = [];
	const mock = createMockContext({
		input: async (title: string) => {
			prompts.push(title);
			return title.startsWith("Git repository") ? remote : "";
		},
		confirm: async (title: string, body: string) => {
			reviews.push(`${title}\n${body}`);
			return confirm;
		},
	});
	return { ...mock, reviews, prompts };
}

function legacySettings() {
	const settings = v3GitSettings();
	Object.assign(settings.syncSetups, {
		work: {
			storage: { connection: "origin", branch: "work", path: "pi-sync/work" },
			sync: { include: ["AGENTS.md"], automatic: true },
			unknownSetupField: "keep",
		},
	});
	return { ...settings, unknownRootField: { keep: true } };
}

test("setup saves one exact destination and selected paths without names or automatic policy prompts", async () => {
	await withTempHome(async (agentDir) => {
		const context = setupContext();
		await showSyncSetup(context.ctx);
		const settings = await readLocalConfigObject();
		assert.ok(settings);
		assert.deepEqual(Object.keys(settings.syncSetups), ["default"]);
		assert.equal(settings.singleTargetSetup, "default");
		assert.equal(
			settings.storageConnections.default.remote,
			"git@github.com:example/new.git",
		);
		assert.deepEqual(settings.syncSetups.default.storage, {
			connection: "default",
			branch: "main",
			path: "./",
		});
		assert.equal(settings.syncSetups.default.sync.automatic, false);
		assert.ok(
			settings.syncSetups.default.sync.include.includes("settings.json"),
		);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/设置已自动保存！/,
		);
		assert.doesNotMatch(
			context.prompts.join("\n"),
			/name|automatic|connection/i,
		);
		assert.equal(existsSync(path.join(agentDir, "settings.json")), false);
		assert.equal(existsSync(path.join(agentDir, "pi-sync/backups")), false);
	});
});

test("setup cancellation on prompt leaves missing or existing settings untouched", async () => {
	for (const configured of [false, true]) {
		await withTempHome(async (agentDir) => {
			mkdirSync(agentDir, { recursive: true });
			const before = JSON.stringify(v3GitSettings());
			if (configured) writeFileSync(localConfigPath(), before);
			writeFileSync(path.join(agentDir, "settings.json"), "{}");
			const cancelledContext = createMockContext({
				input: async () => undefined,
			});
			await showSyncSetup(cancelledContext.ctx);
			assert.equal(existsSync(localConfigPath()), configured);
			if (configured)
				assert.equal(readFileSync(localConfigPath(), "utf8"), before);
			assert.equal(
				readFileSync(path.join(agentDir, "settings.json"), "utf8"),
				"{}",
			);
		});
	}
});

test("ambiguous legacy setups require explicit review once, preserving all other setups and shared connections", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const original = legacySettings();
		writeFileSync(localConfigPath(), JSON.stringify(original));
		await assert.rejects(loadSingleTargetSetup(), /Multiple legacy/);
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () => {
				throw new Error("must not load backend");
			},
		});
		const rpc = createMockContext({ mode: "rpc" });
		for (const route of ["", "status"]) {
			await mock.commands.get("sync")?.handler(route, rpc.ctx);
			assert.match(rpc.notifications.at(-1)?.message ?? "", /Multiple legacy/);
		}
		const context = setupContext();
		context.ctx.ui.select = async (title: string, values: string[]) =>
			title.startsWith("Choose one legacy") ? values[1] : undefined;
		await showSyncSetup(context.ctx);
		const saved = await readLocalConfigObject();
		assert.ok(saved);
		assert.equal(await loadSingleTargetSetup(), "work");
		assert.deepEqual(saved.syncSetups.home, original.syncSetups.home);
		assert.deepEqual(
			saved.storageConnections.origin,
			original.storageConnections.origin,
		);
		assert.deepEqual(saved.unknownRootField, original.unknownRootField);
		assert.equal(saved.syncSetups.work.unknownSetupField, "keep");
		assert.equal(saved.syncSetups.work.storage.connection, "sync-1");
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/设置已自动保存！/,
		);
		const again = setupContext(false, "");
		again.ctx.ui.select = async (title: string) => {
			assert.doesNotMatch(title, /Choose one legacy/);
			return undefined;
		};
		await showSyncSetup(again.ctx);
		assert.equal(await loadSingleTargetSetup(), "work");
		await updateLocalConfig((current) => ({
			...current,
			activeSyncSetup: "home",
		}));
		await assert.rejects(loadSingleTargetSetup(), /Multiple legacy/);
	});
});

test("setup updates configuration directly", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()));
		const context = setupContext();
		await showSyncSetup(context.ctx);
		assert.equal(
			(await readLocalConfigObject())?.storageConnections.origin.remote,
			"git@github.com:example/new.git",
		);
	});
});

test("setup rejects unsupported legacy settings without rewriting or displaying their fields", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = JSON.stringify({ version: 2, secret: "hidden" });
		writeFileSync(localConfigPath(), before);
		const mock = createMockPi();
		sync(mock.pi);
		const context = setupContext();
		await mock.commands.get("sync")?.handler("setup", context.ctx);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/version 3 is required/,
		);
		assert.doesNotMatch(context.notifications.at(-1)?.message ?? "", /hidden/);
		assert.equal(readFileSync(localConfigPath(), "utf8"), before);
	});
});

for (const confirmed of [false, true]) {
	test(`conditional setup migration requires confirmation: ${confirmed}`, async () => {
		await withTempHome(async (agentDir) => {
			const legacy = path.join(agentDir, ".pisync");
			mkdirSync(legacy, { recursive: true });
			writeFileSync(path.join(legacy, "preserved"), "state");
			const { ctx } = createMockContext({
				select: async () => "Migrate state directory…",
				confirm: async () => confirmed,
			});
			assert.equal(await prepareSyncSetup(ctx), confirmed);
			assert.equal(existsSync(legacy), !confirmed);
			assert.equal(
				readFileSync(
					path.join(agentDir, confirmed ? "pi-sync" : ".pisync", "preserved"),
					"utf8",
				),
				"state",
			);
			assert.equal(existsSync(localConfigPath()), false);
		});
	});
	test(`conditional setup abandoned-lock recovery requires confirmation: ${confirmed}`, async () => {
		await withTempHome(async (agentDir) => {
			const state = path.join(agentDir, "pi-sync");
			mkdirSync(state, { recursive: true });
			writeFileSync(path.join(state, "lock"), "unreadable abandoned lock");
			const { ctx } = createMockContext({ confirm: async () => confirmed });
			assert.equal(await prepareSyncSetup(ctx), confirmed);
			assert.equal(existsSync(path.join(state, "lock")), !confirmed);
			assert.equal(existsSync(localConfigPath()), false);
		});
	});
}

test("setup recovery cannot bypass a live owner or coexistence of state roots", async () => {
	await withTempHome(async (agentDir) => {
		const state = path.join(agentDir, "pi-sync");
		mkdirSync(state, { recursive: true });
		writeFileSync(
			path.join(state, "lock"),
			JSON.stringify({
				id: "live",
				pid: process.pid,
				command: "sync",
				startedAt: new Date().toISOString(),
			}),
		);
		const { ctx } = createMockContext({
			confirm: async () => {
				throw new Error("must not offer breaking a live lock");
			},
		});
		await assert.rejects(prepareSyncSetup(ctx), /still live/);
		assert.equal(existsSync(path.join(state, "lock")), true);
		mkdirSync(path.join(agentDir, ".pisync"));
		await assert.rejects(prepareSyncSetup(ctx), /both|Both/);
	});
});
