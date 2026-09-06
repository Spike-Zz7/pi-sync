import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	addSyncSetup,
	loadConfig,
	localConfigPath,
	readLocalConfigObject,
	validateSettingsDocument,
} from "../src/config.js";
import { promptAvailableSetupStorage } from "../src/git-ui.js";
import { showSyncManager } from "../src/manager-ui.js";
import { withTempHome } from "./helpers.js";

initTheme("dark", false);

function seed(value: string) {
	mkdirSync(path.dirname(localConfigPath()), { recursive: true });
	writeFileSync(localConfigPath(), value, { mode: 0o600 });
}
const kinds = ["Git"] as const;

// A free branch must keep the root path default without prompting.
test.each(kinds)(
	"%s free coordinates do not prompt or mutate settings",
	async (kind) => {
		await withTempHome(async () => {
			const { settings, connection } = fixture(kind, false);
			const storage = {
				...settings.syncSetups.home.storage,
				connection,
				path: "./",
				branch: "other",
			};
			const before = JSON.stringify(settings);
			seed(before);
			let prompts = 0;
			const { ctx, notifications } = createMockContext({
				hasUI: true,
				mode: "tui",
				input: async () => {
					prompts++;
					return undefined;
				},
			});
			assert.deepEqual(
				await promptAvailableSetupStorage(ctx, storage),
				storage,
			);
			assert.equal(prompts, 0);
			assert.deepEqual(notifications, []);
			assert.equal(readFileSync(localConfigPath(), "utf8"), before);
		});
	},
);

test.each(kinds)(
	"%s correction rechecks invalid, occupied, and concurrently occupied coordinates",
	async (kind) => {
		await withTempHome(async () => {
			const { settings, connection } = fixture(kind, false);
			seed(JSON.stringify(settings));
			const answers = ["main", "bad..branch", "claimed", "free"];
			let prompts = 0;
			const { ctx, notifications } = createMockContext({
				hasUI: true,
				mode: "tui",
				input: async () => {
					if (prompts === 2) {
						const competitor = structuredClone(settings.syncSetups.home);
						competitor.storage.branch = "claimed";
						await addSyncSetup("competitor", competitor);
					}
					return answers[prompts++];
				},
			});
			const storage = await promptAvailableSetupStorage(ctx, {
				...settings.syncSetups.home.storage,
				connection,
				path: "./",
			});
			assert.equal(prompts, 4);
			assert.equal(storage?.branch, "free");
			assert.ok(notifications.some((n) => /competitor/u.test(n.message)));
			assert.ok(notifications.some((n) => /Invalid/u.test(n.message)));
			assert.deepEqual(
				(await readLocalConfigObject())?.syncSetups.home,
				settings.syncSetups.home,
			);
		});
	},
);

test("location preflight leaves malformed settings untouched", async () => {
	await withTempHome(async () => {
		seed("{invalid");
		const { ctx } = createMockContext({ hasUI: true, mode: "tui" });
		await assert.rejects(
			promptAvailableSetupStorage(ctx, {
				connection: "origin",
				branch: "main",
				path: "./",
			}),
		);
		assert.equal(readFileSync(localConfigPath(), "utf8"), "{invalid");
	});
});

function fixture(_kind: (typeof kinds)[number], alias: boolean) {
	const settings = validateSettingsDocument({
		version: 3,
		activeSyncSetup: "home",
		onSwitch: "ask-before-pull",
		storageConnections: {
			origin: {
				type: "git",
				remote: "git@example.com:private/pi-sync.git",
			},
		},
		syncSetups: {
			home: {
				storage: { connection: "origin", path: "./", branch: "main" },
				sync: { include: ["settings.json"], automatic: false },
			},
		},
	});
	const source = "origin";
	if (alias) {
		settings.storageConnections.alias = structuredClone(
			settings.storageConnections[source],
		);
		const connection = settings.storageConnections.alias;
		connection.remote = "ssh://git@EXAMPLE.com:22/private/pi-sync.git/";
	}
	return { settings, connection: alias ? "alias" : source };
}

for (const kind of kinds) {
	test.each(
		[false, true].flatMap((alias) =>
			["./", "archives/work"].map((storagePath) => ({
				alias,
				storagePath,
			})),
		),
	)(
		`${kind} occupied location requires correction before review (alias=$alias, path=$storagePath)`,
		async ({ alias, storagePath }) => {
			await withTempHome(async () => {
				const { settings, connection } = fixture(kind, alias);
				seed(JSON.stringify(settings));
				const inputs = [
					"work",
					"",
					storagePath === "./" ? "" : storagePath,
					"work-branch",
				];
				const choices = [
					"More…",
					"Sync setups…",
					"Add sync setup",
					connection,
					"Minimal settings",
					"Keep automatic sync off",
					"Add sync setup",
					undefined,
				];
				const titles: string[] = [];
				const { ctx, notifications } = createMockContext({
					hasUI: true,
					mode: "tui",
					input: async (title: string) => {
						titles.push(title);
						return inputs.shift();
					},
					select: async (title: string) => {
						titles.push(title);
						return choices.shift();
					},
				});
				await showSyncManager(ctx, async () => undefined);
				const config = await loadConfig("work");
				assert.equal(config.storagePath, storagePath);
				assert.equal(config.backend.destination.branch, "work-branch");
				assert.deepEqual(
					(await readLocalConfigObject())?.syncSetups.home,
					settings.syncSetups.home,
				);
				const warning = notifications.find((n) =>
					/already used/u.test(n.message),
				);
				assert.ok(warning, JSON.stringify(notifications));
				assert.match(warning.message, /home/u);
				const correction = titles.findIndex((t) =>
					/already used by “/u.test(t),
				);
				const content = titles.findIndex((t) =>
					/Choose (included content|an initial sync preset)/u.test(t),
				);
				assert.ok(correction >= 0 && correction < content, titles.join("\n"));
			});
		},
	);

	test.each(["cancel", "abort"])(
		`${kind} occupied-root correction %s leaves settings untouched`,
		async (action) => {
			await withTempHome(async () => {
				const { settings, connection } = fixture(kind, false);
				const before = JSON.stringify(settings);
				seed(before);
				const controller = new AbortController();
				const inputs = ["work", "", ""];
				const choices = [
					"More…",
					"Sync setups…",
					"Add sync setup",
					connection,
					undefined,
				];
				let correction = false;
				let reviewed = false;
				const { ctx } = createMockContext({
					hasUI: true,
					mode: "tui",
					input: async (title: string) => {
						if (!/already used by “/u.test(title)) return inputs.shift();
						correction = true;
						if (action === "abort") {
							controller.abort(
								new DOMException("Session replaced", "AbortError"),
							);
							return "late";
						}
						return undefined;
					},
					select: async (title: string) => {
						if (/Review .*sync setup/u.test(title)) reviewed = true;
						return choices.shift();
					},
				});
				await showSyncManager(ctx, async () => undefined, controller.signal);
				assert.equal(correction, true);
				assert.equal(reviewed, false);
				assert.equal(readFileSync(localConfigPath(), "utf8"), before);
			});
		},
	);
}
