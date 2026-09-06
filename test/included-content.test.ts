import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
	createCustomSelectorHarness,
	createMockContext,
} from "../../../test/support.js";
import {
	loadConfig,
	localConfigPath,
	readLocalConfigObject,
} from "../src/config.js";
import { showFileSelection } from "../src/file-selection.js";
import {
	DEFAULT_SYNC_INCLUDE,
	formatIncludedContentSummary,
	LEGACY_DEFAULT_SYNC_INCLUDE,
	normalizeSyncFiles,
	PRIMARY_CATEGORIES,
	RECOMMENDED_SYNC_INCLUDE,
	summarizeIncludedContent,
} from "../src/sync-policy.js";
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

function selectRowByLabel(
	harness: ReturnType<typeof createCustomSelectorHarness>,
	targetLabel: string,
) {
	for (let index = 0; index < 32; index += 1) {
		const label = selectedMultiSelectLabel(harness.render());
		if (label === targetLabel) return true;
		harness.handleInput("tui.select.down");
	}
	return false;
}

test("exact new defaults match the 7 recommended paths and old schema fallback is preserved", () => {
	assert.deepEqual(DEFAULT_SYNC_INCLUDE, [
		"settings.json",
		"keybindings.json",
		"AGENTS.md",
		"APPEND_SYSTEM.md",
		"prompts",
		"skills",
		"token-usage.jsonl",
	]);
	assert.deepEqual(RECOMMENDED_SYNC_INCLUDE, DEFAULT_SYNC_INCLUDE);
	assert.equal(DEFAULT_SYNC_INCLUDE.length, 7);

	assert.deepEqual(LEGACY_DEFAULT_SYNC_INCLUDE, [
		"settings.json",
		"keybindings.json",
		"models.json",
		"lsp.json",
		"AGENTS.md",
		"APPEND_SYSTEM.md",
		"skills",
		"prompts",
		"themes",
		"extensions",
		"token-usage.jsonl",
	]);
	assert.equal(LEGACY_DEFAULT_SYNC_INCLUDE.length, 11);

	// Old schema omitted-field effective fallback returns all 11 built-in sync roots
	assert.deepEqual(normalizeSyncFiles(undefined), [
		...LEGACY_DEFAULT_SYNC_INCLUDE,
	]);

	// Primary categories define exactly 4 rows with the 7 paths
	assert.deepEqual(
		PRIMARY_CATEGORIES.map((c) => c.label),
		["Preferences", "Instructions & prompts", "Skills", "Usage records"],
	);
	assert.deepEqual(
		PRIMARY_CATEGORIES.flatMap((c) => c.paths),
		[...DEFAULT_SYNC_INCLUDE],
	);

	// Summary helper formats category count and path count without claiming each file is a group
	const defaultSummary = summarizeIncludedContent(DEFAULT_SYNC_INCLUDE);
	assert.equal(defaultSummary.categoryCount, 4);
	assert.equal(defaultSummary.pathCount, 7);
	assert.equal(defaultSummary.extraCount, 0);
	assert.equal(defaultSummary.hasSessions, false);
	assert.equal(
		formatIncludedContentSummary(DEFAULT_SYNC_INCLUDE),
		"4 categories (7 paths) · Sessions: Off",
	);

	const customSummary = summarizeIncludedContent([
		"settings.json",
		"models.json",
		"sessions",
	]);
	assert.equal(customSummary.categoryCount, 1);
	assert.equal(customSummary.pathCount, 2);
	assert.equal(customSummary.extraCount, 1);
	assert.equal(customSummary.hasSessions, true);
	assert.equal(
		formatIncludedContentSummary(["settings.json", "models.json", "sessions"]),
		"1 category (2 paths) · 1 extra path · Sessions: On",
	);
});

test("no write on open: opening and exiting editor does not modify config", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(
			`${JSON.stringify(v3GitSettings({ include: ["settings.json"] }))}\n`,
		);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		const mtimeBefore = statSync(localConfigPath()).mtimeMs;

		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home");

		const after = readFileSync(localConfigPath());
		assert.deepEqual(after, before);
		assert.equal(statSync(localConfigPath()).mtimeMs, mtimeBefore);
	});
});

test("draft discard: changes are discarded when Discard changes is selected", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(
			`${JSON.stringify(v3GitSettings({ include: ["settings.json"] }))}\n`,
		);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });

		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 80);
				if (screen === 1) {
					// Toggle Skills
					assert.ok(selectRowByLabel(harness, "Skills"));
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					await Promise.resolve();
				} else if (screen === 2) {
					// Exit editor screen to open review
					harness.handleInput("tui.select.cancel");
				} else {
					// In review screen: select Discard changes (row 1)
					harness.handleInput("tui.select.down"); // move from save to discard
					harness.handleInput("tui.select.confirm");
				}
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home");

		assert.equal(screen, 3);
		assert.deepEqual(readFileSync(localConfigPath()), before);
		assert.match(notifications.at(-1)?.message ?? "", /changes discarded/iu);
	});
});

test("grouped toggles: toggling a category group toggles all member files", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		// Start with 0 includes
		writeFileSync(
			localConfigPath(),
			JSON.stringify(v3GitSettings({ include: [] })),
			{ mode: 0o600 },
		);

		let screen = 0;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				if (screen === 1) {
					// Toggle Preferences (selects settings.json and keybindings.json)
					assert.ok(selectRowByLabel(harness, "Preferences"));
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					await Promise.resolve();
				} else if (screen === 2) {
					harness.handleInput("tui.select.cancel");
				} else {
					// Review: Save changes
					harness.handleInput("tui.select.confirm");
				}
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home");
		assert.equal(screen, 3);

		const saved = (await readLocalConfigObject())?.syncSetups.home.sync.include;
		assert.deepEqual(saved, ["settings.json", "keybindings.json"]);
	});
});

test("partial group preservation: partial group is faithfully displayed and not implicitly overwritten", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		// Only settings.json included (1 of 2 in Preferences)
		writeFileSync(
			localConfigPath(),
			JSON.stringify(v3GitSettings({ include: ["settings.json"] })),
			{ mode: 0o600 },
		);

		let screen = 0;
		let editorRender: string[] = [];
		let reviewRender: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 120);
				if (screen === 1) {
					editorRender = harness.render();
					// Toggle Skills
					assert.ok(selectRowByLabel(harness, "Skills"));
					harness.handleInput("tui.select.confirm");
					await harness.waitForPending();
					await Promise.resolve();
				} else if (screen === 2) {
					harness.handleInput("tui.select.cancel");
				} else {
					reviewRender = harness.render();
					// Review: Save changes
					harness.handleInput("tui.select.confirm");
				}
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home");
		assert.equal(screen, 3);

		// Verify editor showed partial description "1/2 selected"
		const editorText = editorRender.join("\n");
		assert.match(editorText, /1\/2 selected/u);
		assert.match(editorText, /settings\.json/u);

		// Verify review only included skills, did NOT touch settings.json or keybindings.json
		const reviewText = reviewRender.join("\n");
		assert.match(reviewText, /Include: skills/u);
		assert.doesNotMatch(reviewText, /keybindings\.json/u);
		assert.doesNotMatch(reviewText, /Exclude: settings\.json/u);

		// Saved config retains settings.json and adds skills, without keybindings.json
		const saved = (await readLocalConfigObject())?.syncSetups.home.sync.include;
		assert.deepEqual(saved, ["settings.json", "skills"]);
	});
});

test("existing optional and session includes are not silently dropped and remain manageable", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const initialIncludes = [
			"settings.json",
			"models.json",
			"lsp.json",
			"themes",
			"extensions",
			"sessions",
			"custom.json",
		];
		writeFileSync(
			localConfigPath(),
			JSON.stringify(v3GitSettings({ include: initialIncludes })),
			{ mode: 0o600 },
		);

		let screen = 0;
		const labels: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				if (screen === 1) {
					for (let index = 0; index < 32; index += 1) {
						const label = selectedMultiSelectLabel(harness.render());
						if (!label || labels.includes(label)) break;
						labels.push(label);
						harness.handleInput("tui.select.down");
					}
					// Exit without changes
					harness.handleInput("tui.select.cancel");
				}
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home");

		// All 4 primary rows plus all 6 extra rows must appear
		assert.deepEqual(labels, [
			"Preferences",
			"Instructions & prompts",
			"Skills",
			"Usage records",
			"custom.json",
			"extensions",
			"lsp.json",
			"models.json",
			"sessions",
			"themes",
			"Add custom path…",
		]);

		// Saved settings remain completely unchanged
		const config = await loadConfig();
		assert.deepEqual(config.include, initialIncludes);
	});
});

test("custom former-built-in addition: Add custom path accepts models.json and normalizes without reserved-path rejection", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			localConfigPath(),
			JSON.stringify(v3GitSettings({ include: ["settings.json"] })),
			{ mode: 0o600 },
		);

		let screen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => "  MODELS.JSON  ",
			custom: async (factory: unknown) => {
				screen += 1;
				const harness = createCustomSelectorHarness(factory, 100);
				if (screen === 1) {
					assert.ok(selectRowByLabel(harness, "Add custom path…"));
					harness.handleInput("tui.select.confirm");
					await Promise.resolve();
				} else if (screen === 2) {
					// Screen 2 re-rendered with models.json added
					assert.match(harness.render().join("\n"), /\[x\] models\.json/u);
					harness.handleInput("tui.select.cancel");
				} else {
					// Review: Save changes
					assert.match(harness.render().join("\n"), /Include: models\.json/u);
					harness.handleInput("tui.select.confirm");
				}
				return harness.result;
			},
		});

		await showFileSelection(ctx, "home");

		assert.equal(screen, 3);
		const saved = (await readLocalConfigObject())?.syncSetups.home.sync.include;
		assert.deepEqual(saved, ["settings.json", "models.json"]);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/Saved included content/u,
		);
	});
});
