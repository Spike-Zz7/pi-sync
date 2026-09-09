import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { completeSyncArguments, SYNC_COMMANDS, usage } from "../src/command.js";
import {
	loadConfig,
	localConfigPath,
	readStateForConfig,
	statePathForConfig,
	updateSyncSetup,
} from "../src/config.js";
import { expectedRemoteHead } from "../src/sync-backend.js";
import sync from "../src/sync-extension.js";
import { status, syncBoth } from "../src/sync-operations.js";
import type { CommandOptions } from "../src/types.js";
import { snapshot, v3GitSettings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { createMockContext, createMockPi } from "./support.js";

initTheme("dark", false);

const options: CommandOptions = {
	yes: true,
	force: false,
	stale: false,
	silent: false,
	reload: false,
	auto: false,
	args: [],
};
function content(files: Record<string, string>, id: string) {
	return {
		...snapshot(
			Object.entries(files).map(([filePath, text]) => ({
				path: filePath,
				content: Buffer.from(text),
			})),
		),
		id,
	};
}
async function publish(
	backend: MemorySyncBackend,
	files: Record<string, string>,
	id: string,
) {
	await backend.publishSnapshot(
		content(files, id),
		expectedRemoteHead(await backend.readHead()),
	);
}
function configure(
	agentDir: string,
	include = ["preferences.txt", "snippets"],
) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(localConfigPath(), JSON.stringify(v3GitSettings({ include })));
}
function localWrite(agentDir: string, relativePath: string, text: string) {
	mkdirSync(path.dirname(path.join(agentDir, relativePath)), {
		recursive: true,
	});
	writeFileSync(path.join(agentDir, relativePath), text);
}

test("only setup/status complete and public command syntax has no flags or manager", async () => {
	assert.deepEqual(
		SYNC_COMMANDS.map(({ name }) => name),
		["setup", "status"],
	);
	assert.deepEqual(
		completeSyncArguments("")?.map(({ value }) => value),
		["setup", "status"],
	);
	assert.equal(completeSyncArguments("status "), null);
	assert.equal(completeSyncArguments("push"), null);
	assert.equal(completeSyncArguments("--force"), null);
	assert.match(usage(), /\/sync setup.*\/sync.*\/sync status/);
	await withTempHome(async (agentDir) => {
		const mock = createMockPi();
		sync(mock.pi);
		const { ctx, notifications } = createMockContext({ mode: "rpc" });
		await mock.commands.get("sync")?.handler("", ctx);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/not configured.*\/sync setup/,
		);
		await mock.commands.get("sync")?.handler("setup", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /TUI mode/);
		assert.equal(existsSync(localConfigPath()), false);
		assert.equal(existsSync(path.join(agentDir, "preferences.txt")), false);
		for (const mode of ["print", "json"]) {
			await assert.rejects(
				mock.commands
					.get("sync")
					?.handler("", createMockContext({ hasUI: false, mode }).ctx),
				/requires TUI or RPC/,
			);
		}
	});
});

test("bare /sync chooses direction automatically without confirmation and status does not apply", async () => {
	await withTempHome(async (agentDir) => {
		configure(agentDir);
		localWrite(agentDir, "preferences.txt", "local");
		const backend = new MemorySyncBackend();
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () => ({
				...(await import("../src/sync-operations.js")),
				syncBoth: (ctx, opts) => syncBoth(ctx, opts, () => backend),
				status: (ctx, opts) => status(ctx, opts, () => backend),
			}),
		});
		const { ctx, notifications } = createMockContext({
			mode: "rpc",
			confirm: async () => {
				throw new Error("unexpected confirmation");
			},
		});
		await mock.commands.get("sync")?.handler("", ctx);
		assert.ok(await backend.readHead());
		await publish(backend, { "preferences.txt": "remote" }, "remote");
		await mock.commands.get("sync")?.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /remote ahead/);
		assert.equal(
			readFileSync(path.join(agentDir, "preferences.txt"), "utf8"),
			"local",
		);
		await mock.commands.get("sync")?.handler("", ctx);
		assert.equal(
			readFileSync(path.join(agentDir, "preferences.txt"), "utf8"),
			"remote",
		);
	});
});

for (const direction of ["local", "remote"]) {
	test(`${direction} deletion propagates within selected scope, including all selected files`, async () => {
		await withTempHome(async (agentDir) => {
			configure(agentDir);
			localWrite(agentDir, "preferences.txt", "base");
			localWrite(agentDir, "snippets/only.txt", "selected");
			localWrite(agentDir, "unselected.txt", "keep local");
			const backend = new MemorySyncBackend();
			const { ctx } = createMockContext();
			await syncBoth(ctx, options, () => backend);
			if (direction === "local") {
				rmSync(path.join(agentDir, "preferences.txt"));
				rmSync(path.join(agentDir, "snippets"), { recursive: true });
			} else await publish(backend, {}, "delete-all");
			await syncBoth(ctx, options, () => backend);
			assert.equal(existsSync(path.join(agentDir, "preferences.txt")), false);
			assert.equal(existsSync(path.join(agentDir, "snippets/only.txt")), false);
			assert.equal(
				readFileSync(path.join(agentDir, "unselected.txt"), "utf8"),
				"keep local",
			);
			const head = await backend.readHead();
			assert.ok(head);
			assert.deepEqual(
				(await backend.readSnapshot(head.snapshotRef)).files.filter(
					(file) => file.path !== "sync-environment.json",
				),
				[],
			);
			assert.deepEqual(
				Object.fromEntries(
					Object.entries(
						(await readStateForConfig(await loadConfig())).lastFileHashes,
					).filter(([name]) => name !== "sync-environment.json"),
				),
				{},
			);
		});
	});
}

test("strict policy withdrawal deletes owned paths; later never-managed additions remain untouched", async () => {
	await withTempHome(async (agentDir) => {
		configure(agentDir);
		localWrite(agentDir, "preferences.txt", "base");
		localWrite(agentDir, "snippets/only.txt", "preserve remote");
		const backend = new MemorySyncBackend();
		const { ctx } = createMockContext();
		await syncBoth(ctx, options, () => backend);
		const before = await backend.readHead();
		await updateSyncSetup("home", (setup) => ({
			...setup,
			sync: { ...setup.sync, include: ["preferences.txt"] },
		}));
		await syncBoth(ctx, options, () => backend);
		assert.notEqual((await backend.readHead())?.revision, before?.revision);
		assert.equal(existsSync(path.join(agentDir, "snippets/only.txt")), false);
		localWrite(agentDir, "snippets/only.txt", "unmanaged local edit");
		localWrite(agentDir, "preferences.txt", "local edit");
		await syncBoth(ctx, options, () => backend);
		const uploaded = await backend.readSnapshot(
			(await backend.readHead())?.snapshotRef,
		);
		assert.equal(
			uploaded.files.find((file) => file.path === "snippets/only.txt")
				?.contentBase64,
			undefined,
		);
		await publish(
			backend,
			{
				"preferences.txt": "remote edit",
				"snippets/only.txt": "unmanaged remote edit",
			},
			"remote-edit",
		);
		await syncBoth(ctx, options, () => backend);
		assert.equal(
			readFileSync(path.join(agentDir, "snippets/only.txt"), "utf8"),
			"unmanaged local edit",
		);
		assert.equal(
			readFileSync(path.join(agentDir, "preferences.txt"), "utf8"),
			"remote edit",
		);
	});
});

test("status fetches content for all four states, ignores revision-only changes, and writes no baseline or managed content", async () => {
	await withTempHome(async (agentDir) => {
		configure(agentDir);
		localWrite(agentDir, "preferences.txt", "base");
		const backend = new MemorySyncBackend();
		const { ctx, notifications } = createMockContext();
		await syncBoth(ctx, options, () => backend);
		const statePath = statePathForConfig(await loadConfig());
		const stateBefore = readFileSync(statePath);
		const configBefore = readFileSync(localConfigPath());
		for (const [local, remote, expected] of [
			["base", "base", "synced"],
			["local", "base", "local ahead"],
			["base", "remote", "remote ahead"],
			["local", "remote", "diverged"],
			["equal", "equal", "synced"],
		]) {
			localWrite(agentDir, "preferences.txt", local);
			await publish(
				backend,
				{ "preferences.txt": remote },
				`revision-${local}-${remote}`,
			);
			const head = await backend.readHead();
			await status(ctx, options, () => backend);
			assert.match(
				notifications.at(-1)?.message ?? "",
				new RegExp(`pi-sync: ${expected}`),
			);
			assert.deepEqual(await backend.readHead(), head);
			assert.deepEqual(readFileSync(statePath), stateBefore);
			assert.deepEqual(readFileSync(localConfigPath()), configBefore);
			assert.equal(
				readFileSync(path.join(agentDir, "preferences.txt"), "utf8"),
				local,
			);
			assert.equal(existsSync(path.join(agentDir, "pi-sync/backups")), false);
		}
	});
});

test("both-side edits and delete-versus-edit divergence stop without mutation", async () => {
	await withTempHome(async (agentDir) => {
		configure(agentDir);
		localWrite(agentDir, "preferences.txt", "base");
		const backend = new MemorySyncBackend();
		const { ctx } = createMockContext();
		await syncBoth(ctx, options, () => backend);
		const statePath = statePathForConfig(await loadConfig());
		const stateBefore = readFileSync(statePath);
		for (const local of ["local change", undefined]) {
			if (local) localWrite(agentDir, "preferences.txt", local);
			else rmSync(path.join(agentDir, "preferences.txt"));
			await publish(
				backend,
				{ "preferences.txt": "remote change" },
				`remote-${local}`,
			);
			const head = await backend.readHead();
			await assert.rejects(
				syncBoth(ctx, options, () => backend),
				/Sync diverged/,
			);
			assert.deepEqual(await backend.readHead(), head);
			assert.deepEqual(readFileSync(statePath), stateBefore);
			assert.equal(
				existsSync(path.join(agentDir, "preferences.txt")),
				local !== undefined,
			);
			assert.equal(existsSync(path.join(agentDir, "pi-sync/backups")), false);
		}
	});
});

for (const scenario of [
	"empty-both",
	"empty-local",
	"empty-remote",
	"equal",
	"different",
	"local-subset",
	"remote-subset",
]) {
	test(`initialization: ${scenario}`, async () => {
		await withTempHome(async (agentDir) => {
			configure(agentDir);
			const local = ["empty-both", "empty-local"].includes(scenario)
				? {}
				: {
						"preferences.txt": "base",
						...(scenario === "remote-subset"
							? { "snippets/extra.txt": "extra" }
							: {}),
					};
			for (const [file, text] of Object.entries(local))
				localWrite(agentDir, file, text);
			const backend = new MemorySyncBackend();
			if (!["empty-both", "empty-remote"].includes(scenario))
				await publish(
					backend,
					{
						"preferences.txt": scenario === "different" ? "remote" : "base",
						...(scenario === "local-subset"
							? { "snippets/extra.txt": "extra" }
							: {}),
					},
					"initial",
				);
			const { ctx, notifications } = createMockContext();
			const statePath = statePathForConfig(await loadConfig());
			await status(ctx, options, () => backend);
			assert.equal(existsSync(statePath), false);
			const head = await backend.readHead();
			if (["different", "local-subset", "remote-subset"].includes(scenario)) {
				assert.match(notifications.at(-1)?.message ?? "", /diverged/);
				await assert.rejects(
					syncBoth(ctx, options, () => backend),
					/no common baseline/,
				);
				assert.deepEqual(await backend.readHead(), head);
				assert.equal(existsSync(statePath), false);
				assert.equal(
					readFileSync(path.join(agentDir, "preferences.txt"), "utf8"),
					"base",
				);
			} else {
				await syncBoth(ctx, options, () => backend);
				if (scenario === "empty-both")
					assert.equal(
						(
							await backend.readSnapshot(
								(await backend.readHead())?.snapshotRef ?? "",
							)
						).version,
						2,
					);
				else
					assert.equal(
						readFileSync(path.join(agentDir, "preferences.txt"), "utf8"),
						"base",
					);
				if (scenario === "equal")
					assert.deepEqual(await backend.readHead(), head);
			}
		});
	});
}

for (const committed of [false, true]) {
	test(`bare TUI sync starts without a manager and respects cancellation boundary: committed=${committed}`, async () => {
		await withTempHome(async (agentDir) => {
			configure(agentDir);
			const tui = createTuiHarness({ width: 48, rows: 16 });
			const mock = createMockPi();
			let operationSignal: AbortSignal | undefined;
			let started: (() => void) | undefined;
			let release: (() => void) | undefined;
			const began = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			sync(mock.pi, {
				loadSyncOperations: async () => ({
					...(await import("../src/sync-operations.js")),
					syncBoth: async (_ctx, opts) => {
						operationSignal = opts.signal;
						if (committed) opts.onCommit?.();
						started?.();
						await gate;
					},
				}),
			});
			const { ctx, notifications } = createMockContext({
				mode: "tui",
				custom: tui.custom,
			});
			const pending = mock.commands.get("sync")?.handler("", ctx);
			await began;
			await tui.waitForOpen();
			tui.press("tui.select.cancel");
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(operationSignal?.aborted, !committed);
			if (committed)
				assert.match(
					notifications.at(-1)?.message ?? "",
					/cannot be cancelled safely/,
				);
			release?.();
			await pending;
			assert.equal(existsSync(statePathForConfig(await loadConfig())), false);
		});
	});
}

test("status leaves interrupted transactions untouched while explicit sync invokes recovery", async () => {
	await withTempHome(async (agentDir) => {
		configure(agentDir);
		localWrite(agentDir, "preferences.txt", "local");
		const transaction = path.join(
			agentDir,
			"pi-sync/transactions/interrupted/journal.json",
		);
		mkdirSync(path.dirname(transaction), { recursive: true });
		writeFileSync(transaction, "invalid journal: must not apply during status");
		const backend = new MemorySyncBackend();
		const mock = createMockPi();
		sync(mock.pi, {
			loadSyncOperations: async () => ({
				...(await import("../src/sync-operations.js")),
				status: (ctx, opts) => status(ctx, opts, () => backend),
				syncBoth: (ctx, opts) => syncBoth(ctx, opts, () => backend),
			}),
		});
		const { ctx, notifications } = createMockContext({ mode: "rpc" });
		await mock.commands.get("sync")?.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /local ahead/);
		assert.equal(
			readFileSync(transaction, "utf8"),
			"invalid journal: must not apply during status",
		);
		assert.equal(
			readFileSync(path.join(agentDir, "preferences.txt"), "utf8"),
			"local",
		);
		await mock.commands.get("sync")?.handler("", ctx);
		assert.equal(notifications.at(-1)?.level, "error");
		assert.equal(await backend.readHead(), undefined);
	});
});
