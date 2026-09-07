import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
	createCustomSelectorHarness,
	createMockContext,
} from "../../../test/support.js";
import {
	localConfigPath,
	readLocalConfigObject,
	updateLocalConfig,
} from "../src/config.js";
import { showFileSelection } from "../src/file-selection.js";
import { isDeniedPath } from "../src/paths.js";
import { syncBoth } from "../src/sync-operations.js";
import { BUILT_IN_SYNC_ROOTS } from "../src/sync-policy.js";
import { v3GitSettings, withTempHome } from "./helpers.js";

initTheme("dark", false);

function selectedMultiSelectLabel(lines: readonly string[]) {
	const line = lines.find(
		(candidate) => candidate.startsWith("→ ") || candidate.startsWith("› "),
	);
	return line
		?.slice(2)
		.replace(/^\[(?:x| |-)\]\s+/u, "")
		.split(/\s{2,}/u)[0]
		?.trim();
}

test("included-content route has a protocol-safe RPC summary", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "rpc",
		});
		await showFileSelection(ctx, "home");
		assert.match(notifications.at(-1)?.message ?? "", /sync setup home/u);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/include: settings.json/u,
		);
		assert.match(notifications.at(-1)?.message ?? "", /sync\.include/u);
	});
});

test("included-content TUI renders textual state at narrow and wide widths", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		const rendered = new Map<number, string[]>();
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				for (const width of [32, 60, 100]) {
					const harness = createCustomSelectorHarness(factory, width);
					rendered.set(width, harness.render());
				}
				const harness = createCustomSelectorHarness(factory, 60);
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		});
		await showFileSelection(ctx, "home");
		for (const [width, lines] of rendered) {
			assert.ok(lines.length > 0);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(lines.join("\n"), /Included Content|included|excluded/u);
		}
	});
});

test("included-content TUI lists primary categories and configured custom paths exactly once", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		for (const root of BUILT_IN_SYNC_ROOTS) {
			const target = path.join(agentDir, root);
			if (root.includes(".")) writeFileSync(target, "{}\n");
			else mkdirSync(target);
		}
		writeFileSync(path.join(agentDir, "custom.json"), "{}\n");
		const before = Buffer.from(
			`${JSON.stringify(v3GitSettings({ include: ["settings.json", "custom.json"] }))}\n`,
		);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		let customCalls = 0;
		const labels: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				customCalls += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				for (let index = 0; index < 32; index += 1) {
					const label = selectedMultiSelectLabel(harness.render());
					if (!label || labels.includes(label)) break;
					labels.push(label);
					harness.handleInput("tui.select.down");
				}
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		});
		await showFileSelection(ctx, "home");
		assert.equal(customCalls, 1);
		assert.deepEqual(labels, [
			"Preferences",
			"Instructions & prompts",
			"Skills",
			"Usage records",
			"custom.json",
			"Add custom path…",
		]);
		assert.deepEqual(readFileSync(localConfigPath()), before);
	});
});

test("included-content TUI adds and saves a custom path that is absent locally", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		const remoteOnlyPath = "remote-only.toml";
		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => remoteOnlyPath,
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				if (screen === 1) {
					for (let index = 0; index < 32; index += 1) {
						if (
							selectedMultiSelectLabel(harness.render()) === "Add custom path…"
						)
							break;
						harness.handleInput("tui.select.down");
					}
					assert.equal(
						selectedMultiSelectLabel(harness.render()),
						"Add custom path…",
					);
					harness.handleInput("tui.select.confirm");
					await Promise.resolve();
				} else if (screen === 2) {
					assert.match(harness.render().join("\n"), /\[x\] remote-only\.toml/u);
					harness.handleInput("tui.select.cancel");
				} else {
					harness.handleInput("tui.select.confirm");
				}
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home");

		assert.equal(screen, 3);
		assert.equal(existsSync(path.join(agentDir, remoteOnlyPath)), false);
		assert.deepEqual(
			(await readLocalConfigObject())?.syncSetups.home.sync.include,
			["settings.json", remoteOnlyPath],
		);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/Saved included content/u,
		);
	});
});

test("included-content TUI rejects an unsafe absent custom path without changing settings", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3GitSettings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => "../outside.toml",
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				if (screen === 1) {
					for (let index = 0; index < 32; index += 1) {
						if (
							selectedMultiSelectLabel(harness.render()) === "Add custom path…"
						)
							break;
						harness.handleInput("tui.select.down");
					}
					assert.equal(
						selectedMultiSelectLabel(harness.render()),
						"Add custom path…",
					);
					harness.handleInput("tui.select.confirm");
					await Promise.resolve();
				} else {
					harness.handleInput("tui.select.cancel");
				}
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home");

		assert.equal(screen, 2);
		assert.deepEqual(readFileSync(localConfigPath()), before);
		assert.match(notifications.at(-1)?.message ?? "", /safe agent-relative/u);
	});
});

test("included-content custom-path input stops on session replacement", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3GitSettings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		const controller = new AbortController();
		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => {
				controller.abort(new DOMException("Session replaced", "AbortError"));
				return "remote-only.toml";
			},
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				for (let index = 0; index < 32; index += 1) {
					if (selectedMultiSelectLabel(harness.render()) === "Add custom path…")
						break;
					harness.handleInput("tui.select.down");
				}
				assert.equal(
					selectedMultiSelectLabel(harness.render()),
					"Add custom path…",
				);
				harness.handleInput("tui.select.confirm");
				await Promise.resolve();
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home", controller.signal);

		assert.equal(screen, 1);
		assert.deepEqual(readFileSync(localConfigPath()), before);
		assert.deepEqual(notifications, []);
	});
});

test("included-content TUI saves a configured custom path once", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
		writeFileSync(path.join(agentDir, "custom.json"), "{}\n");
		writeFileSync(
			localConfigPath(),
			JSON.stringify(
				v3GitSettings({ include: ["settings.json", "custom.json"] }),
			),
			{
				mode: 0o600,
			},
		);
		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				if (screen === 1) {
					for (let index = 0; index < 32; index += 1) {
						if (selectedMultiSelectLabel(harness.render()) === "custom.json")
							break;
						harness.handleInput("tui.select.down");
					}
					assert.equal(
						selectedMultiSelectLabel(harness.render()),
						"custom.json",
					);
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					await Promise.resolve();
				} else if (screen === 2) {
					harness.handleInput("tui.select.cancel");
				} else {
					harness.handleInput("tui.select.confirm");
				}
				return harness.result;
			},
		});
		await showFileSelection(ctx, "home");
		assert.equal(screen, 3);
		assert.deepEqual(
			(await readLocalConfigObject())?.syncSetups.home.sync.include,
			["settings.json"],
		);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/Saved included content/u,
		);
	});
});

test("included-content save preserves a concurrent include change", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings()), {
			mode: 0o600,
		});
		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				if (screen === 1) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					await Promise.resolve();
				} else if (screen === 2) {
					harness.handleInput("tui.select.cancel");
				} else {
					await updateLocalConfig((current) => ({
						...current,
						syncSetups: {
							...current.syncSetups,
							home: {
								...current.syncSetups.home,
								sync: {
									...current.syncSetups.home.sync,
									include: ["models.json"],
								},
							},
						},
					}));
					harness.handleInput("tui.select.confirm");
				}
				return harness.result;
			},
		});
		await showFileSelection(ctx, "home");
		assert.deepEqual(
			(await readLocalConfigObject())?.syncSetups.home.sync.include,
			["models.json"],
		);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/included content changed.*reopen/iu,
		);
	});
});

test("included-content editor disposes on session cancellation without saving", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3GitSettings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		const controller = new AbortController();
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 60);
				controller.abort(new DOMException("Session replaced", "AbortError"));
				harness.dispose();
				return harness.result;
			},
		});
		await showFileSelection(ctx, "home", controller.signal);
		assert.deepEqual(readFileSync(localConfigPath()), before);
		assert.deepEqual(notifications, []);
	});
});

test("an empty include reports no selected content before remote transport", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const settings = v3GitSettings({ include: [] });
		writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
		let fetches = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			fetches += 1;
			throw new Error("unexpected transport");
		};
		try {
			const { ctx, notifications } = createMockContext({
				hasUI: true,
				mode: "rpc",
			});
			await syncBoth(ctx, {
				yes: true,
				force: false,
				stale: false,
				silent: false,
				reload: false,
				auto: false,
				args: [],
			});
			assert.equal(fetches, 0);
			assert.match(notifications.at(-1)?.message ?? "", /includes no files/u);
			assert.doesNotMatch(notifications.at(-1)?.message ?? "", /up to date/iu);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("token-usage.jsonl is a canonical built-in sync root and not blocked by token denial", async () => {
	assert.ok(BUILT_IN_SYNC_ROOTS.includes("token-usage.jsonl"));
	assert.equal(isDeniedPath("token-usage.jsonl"), false);
	assert.equal(isDeniedPath("token-usage.jsonl.backup"), false);
	assert.equal(isDeniedPath("auth_token.txt"), true);
	assert.equal(isDeniedPath("token.json"), true);
});

async function _withStateDirectory(run: () => Promise<void>) {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		await run();
	});
}
