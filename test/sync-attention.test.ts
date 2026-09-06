import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createSyncAttentionController } from "../src/sync-attention.js";

test("attention presentation is sanitized, textual, bounded, and clearable", () => {
	const controller = createSyncAttentionController();
	const { ctx, statuses, widgets } = createMockContext({ hasUI: true, mode: "tui" });
	controller.set(
		{
			setupName: "home\u001b]8;;spoof",
			configIdentity: "identity",
			localInclude: ["settings.json", "AGENTS.md"],
			remoteInclude: ["settings.json", "models.json"],
		},
		"sync",
	);

	controller.publish(ctx);

	assert.equal(statuses.get("sync"), "review needed");
	const factory = widgets.get("sync:attention");
	assert.equal(typeof factory, "function");
	const component = (
		factory as (
			tui: unknown,
			theme: { fg(color: string, text: string): string },
		) => { render(width: number): string[] }
	)({}, { fg: (_color, text) => text });
	for (const width of [32, 60, 100]) {
		const lines = component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.equal(lines.join("\n").includes("\u001b]8"), false);
		assert.match(lines.join("\n"), /Remote 1 · Device 1/u);
		assert.match(lines.join("\n"), /No changes/u);
	}

	controller.clear(ctx);
	assert.equal(statuses.get("sync"), undefined);
	assert.equal(widgets.get("sync:attention"), undefined);
});

test("attention presentation explains an order-only difference", () => {
	const controller = createSyncAttentionController();
	const { ctx, widgets } = createMockContext({ hasUI: true, mode: "tui" });
	controller.set(
		{
			setupName: "home",
			configIdentity: "identity",
			localInclude: ["settings.json", "AGENTS.md"],
			remoteInclude: ["AGENTS.md", "settings.json"],
		},
		"sync",
	);
	controller.publish(ctx);
	const factory = widgets.get("sync:attention") as (
		tui: unknown,
		theme: { fg(color: string, text: string): string },
	) => { render(width: number): string[] };
	const component = factory({}, { fg: (_color, text) => text });
	assert.match(component.render(60).join("\n"), /Only list order differs/u);
});
