import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import esbuild from "esbuild";
import { test } from "vitest";
import {
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
} from "../../../test/support.js";
import {
	addStorageConnection,
	addSyncSetup,
	configuredSyncSetupNames,
	loadConfig,
	localConfigPath,
	readLocalConfigObject,
	removeStorageConnection,
	removeSyncSetup,
	updateLocalConfig,
	updateStorageConnection,
	updateSyncSetup,
} from "../src/config.js";
import {
	withConfigFilePublicationForTest,
	withLocalConfigFileLock,
} from "../src/config-file.js";
import { showSetupWizard } from "../src/manager-ui.js";
import { showSyncSettings } from "../src/settings-ui.js";
import { SetupPullRequiresUiError, useSyncSetup } from "../src/setup-switch.js";
import sync from "../src/sync.js";
import { v3GitSettings, withTempHome } from "./helpers.js";

initTheme("dark", false);
const execFileAsync = promisify(execFile);

function writeSettings(value = v3GitSettings()) {
	writeFileSync(localConfigPath(), `${JSON.stringify(value, null, "\t")}\n`, {
		mode: 0o600,
	});
}

test("cancelling first setup creates neither settings nor sync state", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const mock = createMockPi();
		sync(mock.pi);
		const choices = ["Set up sync", undefined];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => choices.shift(),
		});
		await mock.commands.get("sync")?.handler("", ctx);
		assert.equal(await readLocalConfigObject(), undefined);
		assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
		assert.equal(existsSync(path.join(agentDir, ".pisync")), false);
	});
});

test("Git setup asks directly for a name and cancellation creates no settings or state", async () => {
	await withTempHome(async (agentDir) => {
		const inputs: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async (title: string) => {
				inputs.push(title);
				return undefined;
			},
		});
		assert.equal(await showSetupWizard(ctx), false);
		assert.equal(inputs.length, 1);
		assert.match(inputs[0], /^Sync setup name\n/u);
		assert.equal(await readLocalConfigObject(), undefined);
		assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
		assert.equal(existsSync(path.join(agentDir, ".pisync")), false);
	});
});

test("aborting the name input ignores a late answer without advancing setup", async () => {
	await withTempHome(async () => {
		const controller = new AbortController();
		let inputCalls = 0;
		let receivedSignal: AbortSignal | undefined;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async (
				_title: string,
				_placeholder?: string,
				options?: { signal?: AbortSignal },
			) => {
				inputCalls += 1;
				receivedSignal = options?.signal;
				controller.abort(new DOMException("Session replaced", "AbortError"));
				return "home";
			},
		});
		await assert.rejects(showSetupWizard(ctx, controller.signal), {
			name: "AbortError",
		});
		assert.equal(receivedSignal, controller.signal);
		assert.equal(inputCalls, 1);
		assert.equal(await readLocalConfigObject(), undefined);
	});
});

test("storage connections are reusable by multiple independently named sync setups", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await addSyncSetup("work", {
			storage: {
				connection: "origin",
				branch: "work",
				path: "pi-sync/work",
			},
			sync: { include: ["settings.json"], automatic: false },
		});
		assert.deepEqual(await configuredSyncSetupNames(), ["home", "work"]);
		assert.equal((await loadConfig("work")).connectionName, "origin");
		assert.equal((await loadConfig("work")).storagePath, "pi-sync/work");
	});
});

test("duplicate normalized remote locations fail before publication", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await assert.rejects(
			addSyncSetup("duplicate", {
				storage: {
					connection: "origin",
					branch: "main",
					path: "/pi-sync/home/",
				},
				sync: { include: [], automatic: false },
			}),
			/duplicates the storage location/u,
		);
	});
});

test("referenced connections and a current setup with alternatives cannot be removed", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await addSyncSetup("work", {
			storage: {
				connection: "origin",
				branch: "work",
				path: "pi-sync/work",
			},
			sync: { include: ["settings.json"], automatic: false },
		});
		await assert.rejects(
			removeStorageConnection("origin"),
			/used by sync setup “home”/u,
		);
		await assert.rejects(removeSyncSetup("home"), /another sync setup/u);
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "home");
	});
});

test("removing the sole current setup clears the active reference", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await removeSyncSetup("home");
		const settings = await readLocalConfigObject();
		assert.deepEqual(settings?.syncSetups, {});
		assert.equal(Object.hasOwn(settings ?? {}, "activeSyncSetup"), false);
		assert.ok(settings?.storageConnections.origin);
	});
});

test("storage connection and sync setup CRUD preserve unknown retained fields", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const initial = v3GitSettings() as unknown as Record<string, unknown>;
		initial.futureTop = { keep: true };
		writeSettings(initial as ReturnType<typeof v3GitSettings>);
		await addStorageConnection("git", {
			type: "git",
			remote: "git@github.com:user/pi-sync.git",
			futureConnection: "keep",
		});
		await addSyncSetup("backup", {
			storage: {
				connection: "git",
				branch: "pi-sync/backup",
				path: "pi-sync/backup",
				futureStorage: "keep",
			},
			sync: { include: [], automatic: false, futurePolicy: "keep" },
			futureSetup: "keep",
		});
		await updateStorageConnection("git", (connection) => {
			if (connection.type !== "git") throw new Error("expected Git");
			return { ...connection, remote: "ssh://git@github.com/user/pi-sync.git" };
		});
		await updateSyncSetup("backup", (setup) => ({
			...setup,
			futureSetup: "still",
		}));
		const saved = JSON.parse(readFileSync(localConfigPath(), "utf8"));
		assert.deepEqual(saved.futureTop, { keep: true });
		assert.equal(saved.storageConnections.git.futureConnection, "keep");
		assert.equal(saved.syncSetups.backup.storage.futureStorage, "keep");
		assert.equal(saved.syncSetups.backup.sync.futurePolicy, "keep");
		assert.equal(saved.syncSetups.backup.futureSetup, "still");
	});
});

test("switching setup is atomic and follows all three onSwitch policies", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await addSyncSetup("work", {
			storage: {
				connection: "origin",
				branch: "work",
				path: "pi-sync/work",
			},
			sync: { include: ["settings.json"], automatic: false },
		});
		await updateLocalConfig((settings) => ({
			...settings,
			onSwitch: "switch-only",
		}));
		const mock = createMockContext({ hasUI: true, mode: "tui" });
		assert.deepEqual(await useSyncSetup(mock.ctx, "work"), {
			pullApplied: false,
		});
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "work");

		await updateLocalConfig((settings) => ({
			...settings,
			onSwitch: "ask-before-pull",
			activeSyncSetup: "home",
		}));
		let pullCalls = 0;
		const declined = createMockContext({
			hasUI: true,
			mode: "tui",
			confirm: async () => false,
		});
		assert.deepEqual(
			await useSyncSetup(declined.ctx, "work", async () => {
				pullCalls += 1;
				return "applied";
			}),
			{ pullApplied: false },
		);
		assert.equal(pullCalls, 0);
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "work");

		await updateLocalConfig((settings) => ({
			...settings,
			activeSyncSetup: "home",
		}));
		const accepted = createMockContext({
			hasUI: true,
			mode: "tui",
			confirm: async () => true,
		});
		assert.deepEqual(
			await useSyncSetup(accepted.ctx, "work", async () => {
				pullCalls += 1;
				return "applied";
			}),
			{ pullApplied: true },
		);
		assert.equal(pullCalls, 1);
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "work");

		await updateLocalConfig((settings) => ({
			...settings,
			onSwitch: "pull-after-switch",
		}));
		const noUi = createMockContext({ hasUI: false, mode: "print" });
		await assert.rejects(
			useSyncSetup(noUi.ctx, "home"),
			SetupPullRequiresUiError,
		);
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "work");

		let pulled: string | undefined;
		await assert.rejects(
			useSyncSetup(mock.ctx, "home", async (name) => {
				pulled = name;
				throw new Error("pull failed");
			}),
			/pull failed/u,
		);
		assert.equal(pulled, "home");
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "home");
		assert.deepEqual(await useSyncSetup(mock.ctx, "home"), {
			pullApplied: false,
		});
	});
});

test("cross-process settings mutations serialize under one read-modify-write lock", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		const cacheDir = path.join(process.cwd(), "node_modules/.cache");
		mkdirSync(cacheDir, { recursive: true });
		const tempDir = mkdtempSync(path.join(cacheDir, "test-cfg-"));
		const configJsPath = path.join(tempDir, "config.mjs");
		const compiled = esbuild.buildSync({
			entryPoints: [path.resolve("src/config.ts")],
			bundle: true,
			platform: "node",
			format: "esm",
			packages: "external",
			write: false,
		});
		writeFileSync(configJsPath, compiled.outputFiles[0].text);
		const configModule = pathToFileURL(configJsPath).href;
		const mutate = (field: string) =>
			execFileAsync(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`import { updateLocalConfig } from ${JSON.stringify(configModule)}; await updateLocalConfig((settings) => ({ ...settings, ${field}: true }));`,
				],
				{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
			);
		try {
			await Promise.all([mutate("processOne"), mutate("processTwo")]);
			const saved = JSON.parse(readFileSync(localConfigPath(), "utf8"));
			assert.equal(saved.processOne, true);
			assert.equal(saved.processTwo, true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

test("concurrent settings mutations serialize without dropping either update", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await Promise.all([
			updateLocalConfig((settings) => ({ ...settings, alpha: true })),
			updateLocalConfig((settings) => ({ ...settings, beta: true })),
		]);
		const settings = JSON.parse(readFileSync(localConfigPath(), "utf8"));
		assert.equal(settings.alpha, true);
		assert.equal(settings.beta, true);
	});
});

test("an aborted settings mutation waiting on the update queue never publishes", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		let releaseLock = () => {};
		let reportLockHeld = () => {};
		const lockHeld = new Promise<void>((resolve) => {
			reportLockHeld = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		const blocker = withLocalConfigFileLock(async () => {
			reportLockHeld();
			await release;
		});
		await lockHeld;
		const first = updateLocalConfig((settings) => ({
			...settings,
			first: true,
		}));
		const controller = new AbortController();
		const queued = updateLocalConfig(
			(settings) => ({ ...settings, second: true }),
			controller.signal,
		);
		const rejected = assert.rejects(queued, { name: "AbortError" });
		controller.abort(new DOMException("Aborted while queued", "AbortError"));
		releaseLock();
		await blocker;
		await first;
		await rejected;
		const saved = JSON.parse(readFileSync(localConfigPath(), "utf8"));
		assert.equal(saved.first, true);
		assert.equal(saved.second, undefined);
	});
});

test("an aborted settings mutation waiting on the cross-process lock never publishes", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		const before = readFileSync(localConfigPath());
		let releaseLock = () => {};
		let reportLockHeld = () => {};
		const lockHeld = new Promise<void>((resolve) => {
			reportLockHeld = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		const blocker = withLocalConfigFileLock(async () => {
			reportLockHeld();
			await release;
		});
		await lockHeld;
		const controller = new AbortController();
		const queued = updateLocalConfig(
			(settings) => ({ ...settings, aborted: true }),
			controller.signal,
		);
		const rejected = assert.rejects(queued, { name: "AbortError" });
		controller.abort(new DOMException("Aborted while waiting", "AbortError"));
		releaseLock();
		await blocker;
		await rejected;
		assert.deepEqual(readFileSync(localConfigPath()), before);
	});
});

test("settings UI exposes local editing and synced-content comparison", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3GitSettings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		let rendered = "";
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 100);
				rendered = harness.render().join("\n");
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		});

		await showSyncSettings(ctx, async () => undefined);

		assert.match(rendered, /Included content/u);
		assert.match(rendered, /Compare synced content/u);
		assert.deepEqual(readFileSync(localConfigPath()), before);
	});
});

test("settings UI persists the global secret-scan override", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 100);
				harness.handleInput("tui.select.down");
				harness.handleInput("\r");
				for (
					let attempt = 0;
					attempt < 100 && notifications.length === 0;
					attempt += 1
				) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				harness.handleInput("\u001b");
				return harness.result;
			},
		});

		await showSyncSettings(ctx, async () => undefined);

		assert.equal((await loadConfig()).skipSecretScan, true);
		assert.equal((await readLocalConfigObject())?.skipSecretScan, true);
	});
});

test("settings UI disposes on session replacement without mutating settings", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3GitSettings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		const controller = new AbortController();
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				harness.handleInput("\r");
				controller.abort(new DOMException("Session replaced", "AbortError"));
				harness.dispose();
				return harness.result;
			},
		});
		await showSyncSettings(ctx, async () => undefined, controller.signal);
		assert.deepEqual(readFileSync(localConfigPath()), before);
		assert.deepEqual(notifications, []);
	});
});

test("settings UI restores its displayed value when a private atomic save is rejected", {
	skip: process.platform === "win32",
}, async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		let afterFailure = "";
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				harness.handleInput("tui.select.down");
				harness.handleInput("\r");
				for (
					let attempt = 0;
					attempt < 100 && notifications.length === 0;
					attempt += 1
				) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				afterFailure = harness.render().join("\n");
				harness.handleInput("\u001b");
				return harness.result;
			},
		});

		await withConfigFilePublicationForTest(
			() => Promise.reject(new Error("simulated private atomic save failure")),
			async () => {
				await showSyncSettings(ctx, async () => undefined);
			},
		);

		assert.match(afterFailure, /Skip secret scan\s+Off/u);
		assert.match(
			notifications[0]?.message ?? "",
			/simulated private atomic save failure/u,
		);
		assert.equal((await loadConfig()).skipSecretScan, false);
	});
});

test("invalid files block CRUD and remain byte-for-byte unchanged", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const bytes = Buffer.from('{"version":2,"secret":"hidden"}\n');
		writeFileSync(localConfigPath(), bytes, { mode: 0o600 });
		const before = readFileSync(localConfigPath());
		const beforeStat = statSync(localConfigPath());
		const actions = [
			() =>
				addStorageConnection("extra", {
					type: "git",
					remote: "git@github.com:user/pi-sync.git",
				}),
			() => removeStorageConnection("extra"),
			() =>
				addSyncSetup("extra", {
					storage: {
						connection: "extra",
						branch: "main",
						path: "pi-sync/extra",
					},
					sync: { include: [], automatic: false },
				}),
			() => removeSyncSetup("extra"),
			() => updateStorageConnection("extra", (profile) => profile),
			() => updateSyncSetup("extra", (setup) => setup),
		];
		for (const action of actions) {
			await assert.rejects(action(), (error: unknown) => {
				assert.match(String(error), /version 3/iu);
				assert.doesNotMatch(String(error), /hidden/u);
				return true;
			});
			assert.deepEqual(readFileSync(localConfigPath()), before);
			assert.equal(statSync(localConfigPath()).mtimeMs, beforeStat.mtimeMs);
		}
	});
});

test("setup-switch queues before a later settings mutation even while reads are locked", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await addSyncSetup("work", {
			storage: { connection: "origin", branch: "work", path: "work" },
			sync: { include: ["settings.json"], automatic: false },
		});
		await updateLocalConfig((settings) => ({
			...settings,
			onSwitch: "switch-only",
		}));
		const { ctx } = createMockContext({ hasUI: true, mode: "tui" });
		const mutations = await withLocalConfigFileLock(async () => [
			useSyncSetup(ctx, "work"),
			updateLocalConfig((settings) => ({
				...settings,
				activeSyncSetup: "home",
			})),
		]);
		await Promise.all(mutations);
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "home");
	});
});
