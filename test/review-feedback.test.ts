import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	addSyncSetup,
	loadConfig,
	localConfigPath,
	readLocalConfigObject,
	updateLocalConfig,
	updateStorageConnection,
	updateSyncSetup,
} from "../src/config.js";
import { showSyncManager } from "../src/manager-ui.js";
import { errorMessage, redact } from "../src/sync-format.js";
import { v3GitSettings, withTempHome } from "./helpers.js";

test("shared connection edits reject a stale dependent-setup preview", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		await addSyncSetup("work", {
			storage: {
				connection: "origin",
				branch: "work",
				path: "pi-sync/work",
			},
			sync: { include: ["settings.json"], automatic: false },
		});
		await assert.rejects(
			updateStorageConnection("origin", (value) => value, ["home"]),
			/usage changed/u,
		);
	});
});

test("setup edits are validated as one complete document before publication", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		const before = readFileSync(localConfigPath());
		await assert.rejects(
			updateSyncSetup("home", (setup) => ({
				...setup,
				storage: {
					connection: "origin",
					branch: "main",
					path: "../escape",
				},
			})),
			/safe relative path/u,
		);
		assert.deepEqual(readFileSync(localConfigPath()), before);
	});
});

test("Git setup edit rejects coordinates changed while its review is open", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const settings = v3GitSettings();
		(settings.storageConnections as Record<string, unknown>).secondary = {
			type: "git",
			remote: "git@github.com:example/secondary.git",
		};
		writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
		const choices = [
			"More…",
			"Sync setups…",
			"home (current)",
			"Edit sync setup…",
			"Back",
			"Back",
			"Back",
			undefined,
		];
		const inputs = ["reviewed-branch", "reviewed/path"];
		let rebound = false;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => inputs.shift(),
			select: async (title: string) => {
				if (title.includes("Review")) {
					rebound = true;
					await updateLocalConfig((current) => ({
						...current,
						syncSetups: {
							...current.syncSetups,
							home: {
								...current.syncSetups.home,
								storage: {
									connection: "secondary",
									branch: "rebound-branch",
									path: "rebound/path",
								},
							},
						},
					}));
					return "Save sync setup";
				}
				return choices.shift();
			},
		});
		await showSyncManager(ctx, async () => undefined);
		assert.equal(rebound, true);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/changed while it was open/u,
		);
		const config = await loadConfig();
		assert.equal(config.connectionName, "secondary");
		assert.equal(config.storagePath, "rebound/path");
	});
});

test("setup switch rejects a destination changed while its review is open", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const settings = v3GitSettings();
		settings.onSwitch = "switch-only";
		(settings.syncSetups as Record<string, unknown>).work = {
			storage: {
				connection: "origin",
				branch: "work",
				path: "pi-sync/work",
			},
			sync: { include: ["settings.json"], automatic: false },
		};
		writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
		let mainVisits = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async (title: string) => {
				if (title.includes("Manage sync")) {
					mainVisits += 1;
					return mainVisits === 1 ? "Switch sync setup" : undefined;
				}
				if (title.includes("Current sync setup:")) return "work";
				return undefined;
			},
			confirm: async (title: string) => {
				if (!title.includes("Switch sync setup")) return true;
				await updateLocalConfig((current) => ({
					...current,
					syncSetups: {
						...current.syncSetups,
						work: {
							...current.syncSetups.work,
							storage: {
								connection: "origin",
								branch: "work",
								path: "changed/work",
							},
						},
					},
				}));
				return true;
			},
		});
		await showSyncManager(ctx, async () => undefined);
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "home");
		assert.match(
			notifications.at(-1)?.message ?? "",
			/changed while.*preview/u,
		);
	});
});

test("credential-bearing validation errors and formatting redact exact secrets", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const settings = v3GitSettings();
		settings.storageConnections.origin.remote =
			"https://user:private-secret@example.com/repo.git";
		writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
		await assert.rejects(loadConfig(), (error: unknown) => {
			assert.doesNotMatch(errorMessage(error), /private-secret/u);
			return true;
		});
		assert.equal(redact("private-secret"), "priv…cret");
	});
});

test("non-TUI invalid setup feedback is observable and secret-free", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const settings = v3GitSettings();
		settings.syncSetups.home.storage.path = "../bad";
		writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
		const { notifications } = createMockContext({ hasUI: true });
		let validationError: unknown;
		try {
			await loadConfig();
		} catch (error) {
			validationError = error;
		}
		notifications.push({
			message: errorMessage(validationError),
			level: "error",
		});
		assert.match(notifications.at(-1)?.message ?? "", /safe relative path/u);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /secret-key/u);
		assert.equal(
			await readLocalConfigObject().catch(() => undefined),
			undefined,
		);
	});
});
