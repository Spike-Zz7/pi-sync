import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
	ExtensionInputComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/config.js";
import { requiredInput, requiredValueInput } from "../src/manager-helpers.js";
import { showSetupWizard } from "../src/manager-ui.js";
import { withTempHome } from "./helpers.js";

initTheme("dark", false);

const fixtures = [
	{
		preset: "Git",
		inputs: ["", "git@github.com:owner/private-pi-sync.git", "", ""],
		choices: ["Keep automatic sync off", "Save setup"],
		path: "./",
		hints: [
			"git@github.com:owner/private-pi-sync.git (SSH)",
			"https://github.com/owner/private-pi-sync.git (HTTPS)",
			"entire branch",
			"Default: main",
			"Default: ./",
			"repository root",
		],
	},
];

for (const fixture of fixtures) {
	test(`${fixture.preset} setup renders examples and accepts defaults with one name`, async () => {
		await withTempHome(async () => {
			const choices = [...fixture.choices];
			const inputs = [...fixture.inputs];
			const titles: string[] = [];
			const frames: string[] = [];
			let bounded = true;
			const { ctx } = createMockContext({
				hasUI: true,
				mode: "tui",
				select: async () => choices.shift(),
				input: async (title: string, placeholder?: string) => {
					titles.push(title);
					let answer: string | undefined;
					const input = new ExtensionInputComponent(
						title,
						placeholder,
						(value) => {
							answer = value;
						},
						() => {},
					);
					try {
						for (const width of [32, 80]) {
							const lines = input.render(width);
							bounded &&= lines.every((line) => visibleWidth(line) <= width);
							frames.push(lines.join(" "));
						}
						input.handleInput(inputs.shift() ?? "");
						input.handleInput("\r");
						return answer;
					} finally {
						input.dispose();
					}
				},
			});
			assert.equal(await showSetupWizard(ctx), true);
			assert.equal(bounded, true);
			assert.equal(
				titles.filter((title) => /name/iu.test(title.split("\n")[0])).length,
				1,
			);
			const text = stripVTControlCharacters(frames.join(" ")).replace(
				/\s+/gu,
				" ",
			);
			for (const hint of fixture.hints) assert.ok(text.includes(hint), hint);
			const config = await loadConfig();
			assert.equal(config.setupName, "default");
			assert.equal(config.connectionName, "default");
			assert.equal(config.backend.type, "git");
			assert.equal(config.storagePath, fixture.path);
			assert.equal(config.automatic, false);
		});
	});
}

test.each(["", "   "])(
	"example-only inputs reject blank %j instead of saving an example",
	async (value) => {
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => value,
		});
		assert.equal(
			await requiredValueInput(
				ctx,
				"Endpoint",
				"https://example.com",
				undefined,
			),
			undefined,
		);
		assert.match(notifications.at(-1)?.message ?? "", /Endpoint is required/);
	},
);

test.each(["", "   "])(
	"defaulted inputs accept blank %j and fall back to the default value",
	async (value) => {
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => value,
		});
		assert.equal(
			await requiredInput(ctx, "Region", "us-east-1", undefined),
			"us-east-1",
		);
		assert.deepEqual(notifications, []);
	},
);
