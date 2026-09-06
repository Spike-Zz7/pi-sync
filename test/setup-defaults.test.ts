import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { ExtensionInputComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig, localConfigPath } from "../src/config.js";
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
	{
		preset: "WebDAV",
		inputs: ["", "https://cloud.example.com/dav", "user", ""],
		choices: [
			"Minimal settings",
			"Keep automatic sync off",
			"Keep sessions off (recommended)",
			"Save setup",
		],
		path: "./",
		hints: [
			"Example: https://cloud.example.com/remote.php/dav/files/user",
			"collection URL",
			"Default: ./",
			"collection root",
		],
	},
	...["Cloudflare R2", "Other S3-compatible storage"].map((preset) => ({
		preset,
		inputs: [
			"",
			preset === "Cloudflare R2"
				? "https://account.r2.cloudflarestorage.com"
				: "https://s3.example.com",
			...(preset === "Cloudflare R2" ? [] : [""]),
			"existing-bucket",
			"",
			"access-key",
		],
		choices: [
			"Customize remote location",
			"Store credentials privately",
			"Minimal settings",
			"Keep automatic sync off",
			"Keep sessions off (recommended)",
			"Save sync setup",
		],
		path: "./",
		hints: [
			"Example: https://",
			"Example: pi-sync",
			"bucket must already exist",
			"Object-key prefix",
			"Default: ./",
			"bucket root",
			...(preset === "Cloudflare R2" ? [] : ["Default: us-east-1"]),
		],
	})),
];

for (const fixture of fixtures) {
	test(`${fixture.preset} setup renders examples and accepts defaults with one name`, async () => {
		await withTempHome(async () => {
			const choices = [fixture.preset, ...fixture.choices];
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
				custom: secretInput,
			});
			assert.equal(await showSetupWizard(ctx), true);
			assert.equal(bounded, true);
			assert.equal(
				titles.filter(
					(title) => /name/iu.test(title.split("\n")[0]) && !title.startsWith("WebDAV username"),
				).length,
				1,
			);
			const text = stripVTControlCharacters(frames.join(" ")).replace(/\s+/gu, " ");
			for (const hint of fixture.hints) assert.ok(text.includes(hint), hint);
			const config = await loadConfig();
			assert.equal(config.setupName, "default");
			assert.equal(config.connectionName, "default");
			assert.equal(config.storagePath, fixture.path);
			assert.equal(config.snapshotIdentity, "root");
			if (config.backend.type === "git") assert.equal(config.backend.destination.branch, "main");
			if (config.backend.type === "s3")
				assert.equal(
					config.backend.profile.region,
					fixture.preset === "Cloudflare R2" ? "auto" : "us-east-1",
				);
		});
	});

	test.each(fixture.inputs.map((_, index) => index))(
		`${fixture.preset} cancellation at input %s never saves defaults`,
		async (cancelAt) => {
			await withTempHome(async () => {
				const choices = [fixture.preset, ...fixture.choices];
				let index = 0;
				const { ctx } = createMockContext({
					hasUI: true,
					mode: "tui",
					select: async () => choices.shift(),
					input: async () => (index === cancelAt ? undefined : fixture.inputs[index++]),
					custom: secretInput,
				});
				assert.equal(await showSetupWizard(ctx), false);
				assert.equal(existsSync(localConfigPath()), false);
			});
		},
	);

	test(`${fixture.preset} blank remote or endpoint is not replaced with an example`, async () => {
		await withTempHome(async () => {
			const inputs = ["default", "   "];
			const { ctx } = createMockContext({
				hasUI: true,
				mode: "tui",
				select: async () => fixture.preset,
				input: async () => inputs.shift(),
			});
			assert.equal(await showSetupWizard(ctx), false);
			assert.equal(existsSync(localConfigPath()), false);
		});
	});

	test(`${fixture.preset} cancelling final review does not save`, async () => {
		await withTempHome(async () => {
			const choices = [fixture.preset, ...fixture.choices.slice(0, -1), "Cancel"];
			const inputs = [...fixture.inputs];
			const { ctx } = createMockContext({
				hasUI: true,
				mode: "tui",
				select: async () => choices.shift(),
				input: async () => inputs.shift(),
				custom: secretInput,
			});
			assert.equal(await showSetupWizard(ctx), false);
			assert.equal(existsSync(localConfigPath()), false);
		});
	});
}

test.each(
	fixtures.filter((fixture) => fixture.preset.includes("R2") || fixture.preset.includes("S3")),
)("$preset ignores a storage-location answer after session replacement", async (fixture) => {
	await withTempHome(async () => {
		const controller = new AbortController();
		let inputCount = 0;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => fixture.inputs[inputCount++],
			select: async (title: string) => {
				if (!title.startsWith("Choose storage location")) return fixture.preset;
				controller.abort(new DOMException("Session replaced", "AbortError"));
				return "Customize remote location";
			},
		});
		assert.equal(await showSetupWizard(ctx, controller.signal), false);
		assert.equal(inputCount, fixture.inputs.indexOf("existing-bucket"));
		assert.equal(existsSync(localConfigPath()), false);
	});
});

test.each(["", "   "])(
	"example-only inputs reject blank %j instead of saving an example",
	async (value) => {
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async () => value,
		});
		assert.equal(
			await requiredValueInput(ctx, "Endpoint", "https://example.com", undefined),
			undefined,
		);
		assert.match(notifications[0].message, /required/u);
	},
);

test.each([requiredInput, requiredValueInput])(
	"input ignores answers after session cancellation",
	async (prompt) => {
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async (_title: string, _placeholder?: string, options?: { signal?: AbortSignal }) => {
				received = options?.signal;
				controller.abort(new DOMException("Session replaced", "AbortError"));
				return "late";
			},
		});
		await assert.rejects(prompt(ctx, "Path", "example", controller.signal), { name: "AbortError" });
		assert.equal(received, controller.signal);
	},
);

async function secretInput(factory: unknown) {
	const tui = createTuiHarness({ width: 48 });
	const running = tui.custom(factory as Parameters<typeof tui.custom>[0]);
	await tui.waitForOpen();
	tui.type("private-password");
	tui.press("tui.input.submit");
	return running;
}
