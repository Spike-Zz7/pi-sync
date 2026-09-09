import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createSnapshot } from "../src/snapshot.js";
import { applySnapshot } from "../src/snapshot-apply.js";
import {
	addTopLevelCaseVariantDeletes,
	collectFiles,
	preflightSnapshotApply,
} from "../src/sync.js";

import { snapshot, withTempHome } from "./helpers.js";

initTheme("dark", false);

test("snapshot preserves selected paths that are currently missing", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
		const created = await createSnapshot("home", {
			include: ["settings.json", "pi-starship.toml"],
		});
		assert.deepEqual(created.selection, {
			version: 1,
			include: ["settings.json", "pi-starship.toml"],
		});
		assert.deepEqual(
			created.files.map((file) => file.path),
			["settings.json"],
		);
	});
});

test("refreshTokenUsageLedger generates token-usage.jsonl from sessions without snapshot side effects", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const sessionsDir = path.join(agentDir, "sessions", "work");
		mkdirSync(sessionsDir, { recursive: true });

		const sessionLine = JSON.stringify({
			type: "message",
			id: "auto-token-msg-1",
			timestamp: Date.now(),
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-3-5-sonnet",
				usage: {
					input: 120,
					output: 45,
					totalTokens: 165,
					cost: { total: 0.005 },
				},
			},
		});
		writeFileSync(path.join(sessionsDir, "session.jsonl"), `${sessionLine}\n`);

		// createSnapshot must remain purely observational and must not create token-usage.jsonl
		const initialSnapshot = await createSnapshot("home", {
			include: ["token-usage.jsonl"],
			sessionDir: path.join(agentDir, "sessions"),
		});
		assert.strictEqual(
			initialSnapshot.files.some((f) => f.path === "token-usage.jsonl"),
			false,
		);

		// Explicit helper call updates/generates the file when requested
		const { refreshTokenUsageLedger } = await import("../src/snapshot.js");
		await refreshTokenUsageLedger(path.join(agentDir, "sessions"));

		const ledgerContent = readFileSync(
			path.join(agentDir, "token-usage.jsonl"),
			"utf8",
		);
		assert.match(ledgerContent, /auto-token-msg-1/u);
		assert.match(ledgerContent, /claude-3-5-sonnet/u);

		const snapshotWithFile = await createSnapshot("home", {
			include: ["token-usage.jsonl"],
			sessionDir: path.join(agentDir, "sessions"),
		});
		assert.ok(
			snapshotWithFile.files.some((f) => f.path === "token-usage.jsonl"),
		);
	});
});

test("snapshot collection includes session jsonl files only when enabled", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-collect-"));
	mkdirSync(path.join(root, "skills"), { recursive: true });
	mkdirSync(path.join(root, "sessions", "--project--"), { recursive: true });
	mkdirSync(path.join(root, "sessions", "token-project"), { recursive: true });
	writeFileSync(path.join(root, "APPEND_SYSTEM.md"), "append\n");
	writeFileSync(path.join(root, "LOCAL.md"), "local\n");
	writeFileSync(path.join(root, "local-case.md"), "local case\n");
	writeFileSync(path.join(root, "settings.json"), "{}\n");
	writeFileSync(path.join(root, "skills", "demo.md"), "demo\n");
	if (path.sep === "/")
		writeFileSync(path.join(root, "skills", "foo\\bar.md"), "skip\n");
	writeFileSync(
		path.join(root, "sessions", "--project--", "session.jsonl"),
		"{}\n",
	);
	writeFileSync(
		path.join(root, "sessions", "--project--", "notes.txt"),
		"skip\n",
	);
	writeFileSync(
		path.join(root, "sessions", "token-project", "session.jsonl"),
		"skip\n",
	);
	const customSessionDir = mkdtempSync(
		path.join(os.tmpdir(), "pi-sync-sessions-"),
	);
	writeFileSync(path.join(customSessionDir, "custom.jsonl"), "{}\n");

	assert.deepEqual(
		(await collectFiles(root)).map((file) => file.path),
		["APPEND_SYSTEM.md", "settings.json", "skills/demo.md"],
	);
	const caseRoot = mkdtempSync(path.join(os.tmpdir(), "pi-sync-collect-case-"));
	writeFileSync(path.join(caseRoot, "append_system.md"), "append\n");
	assert.deepEqual(
		(await collectFiles(caseRoot)).map((file) => file.path),
		["APPEND_SYSTEM.md"],
	);
	assert.deepEqual(
		(await collectFiles(root, { extraFiles: ["LOCAL.md"] })).map(
			(file) => file.path,
		),
		["APPEND_SYSTEM.md", "LOCAL.md", "settings.json", "skills/demo.md"],
	);
	assert.deepEqual(
		(await collectFiles(root, { extraFiles: ["LOCAL-CASE.md"] })).map(
			(file) => file.path,
		),
		["APPEND_SYSTEM.md", "LOCAL-CASE.md", "settings.json", "skills/demo.md"],
	);
	writeFileSync(path.join(root, "LOCAL-CASE.md"), "local exact case\n");
	if (readdirSync(root).includes("LOCAL-CASE.md")) {
		const exactCaseFiles = await collectFiles(root, {
			extraFiles: ["LOCAL-CASE.md"],
		});
		assert.deepEqual(
			exactCaseFiles.map((file) => file.path),
			["APPEND_SYSTEM.md", "LOCAL-CASE.md", "settings.json", "skills/demo.md"],
		);
		assert.equal(
			Buffer.from(
				exactCaseFiles.find((file) => file.path === "LOCAL-CASE.md")
					?.contentBase64 ?? "",
				"base64",
			).toString("utf8"),
			"local exact case\n",
		);
	}
	assert.deepEqual(
		(await collectFiles(root, { syncSessions: true })).map((file) => file.path),
		[
			"APPEND_SYSTEM.md",
			"sessions/--project--/session.jsonl",
			"settings.json",
			"skills/demo.md",
		],
	);
	assert.deepEqual(
		(
			await collectFiles(root, {
				syncSessions: true,
				sessionDir: customSessionDir,
			})
		).map((file) => file.path),
		[
			"APPEND_SYSTEM.md",
			"sessions/custom.jsonl",
			"settings.json",
			"skills/demo.md",
		],
	);
	const nestedSessionDir = path.join(root, "sessions", "work");
	mkdirSync(nestedSessionDir, { recursive: true });
	writeFileSync(path.join(nestedSessionDir, "nested.jsonl"), "{}\n");
	assert.deepEqual(
		(
			await collectFiles(root, {
				syncSessions: true,
				sessionDir: nestedSessionDir,
			})
		).map((file) => file.path),
		[
			"APPEND_SYSTEM.md",
			"sessions/nested.jsonl",
			"settings.json",
			"skills/demo.md",
		],
	);
});

test("snapshot preflight validates checksums, duplicate session paths, and deletes stale files", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-apply-"));
	const content = Buffer.from("hello");
	const remote = snapshot([{ path: "settings.json", content }]);
	const current = snapshot([
		{ path: "settings.json", content },
		{ path: "sessions/--project--/old.jsonl", content: Buffer.from("old") },
	]);

	const plan = preflightSnapshotApply(root, remote, current);
	assert.deepEqual(
		plan.writes.map((item) => item.target),
		[path.join(root, "settings.json")],
	);
	assert.deepEqual(plan.deletes, [
		path.join(root, "sessions", "--project--", "old.jsonl"),
	]);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				snapshot([{ path: "../bad", content }]),
				current,
			),
		/Unsafe path/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(root, snapshot([{ path: ".", content }]), current),
		/Unsafe path/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				snapshot([{ path: "..", content }]),
				current,
			),
		/Unsafe path/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				snapshot([{ path: "sessions\\bad.jsonl", content }]),
				current,
			),
		/Unsafe path/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				snapshot([{ path: "sessions/../settings.json", content }]),
				current,
			),
		/Unsafe path/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				snapshot([{ path: ".env", content }]),
				current,
			),
		/Unsafe path/,
	);
	const sessionSnapshot = snapshot([
		{ path: "sessions/--project--/session.jsonl", content },
	]);
	const customSessionDir = mkdtempSync(
		path.join(os.tmpdir(), "pi-sync-session-apply-"),
	);
	assert.deepEqual(
		preflightSnapshotApply(root, sessionSnapshot, snapshot([]), {
			sessionDir: customSessionDir,
		}).writes.map((item) => item.target),
		[path.join(customSessionDir, "--project--", "session.jsonl")],
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				{
					...sessionSnapshot,
					files: [sessionSnapshot.files[0], sessionSnapshot.files[0]],
				},
				current,
			),
		/Duplicate path/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				{
					...sessionSnapshot,
					files: [{ ...sessionSnapshot.files[0], sha256: "bad" }],
				},
				current,
			),
		/Checksum mismatch/,
	);
	assert.throws(
		() =>
			preflightSnapshotApply(
				root,
				snapshot([{ path: "sessions/--project--/notes.txt", content }]),
				current,
			),
		/Unsafe session path/,
	);
});

test("snapshot apply restores the complete prior state at every mutation boundary", async () => {
	for (const boundary of [
		{ method: "rm", file: "AGENTS.md" },
		{ method: "writeFile", file: "keybindings.json" },
		{ method: "writeFile", file: "settings.json" },
	] as const) {
		await withTempHome(async (agentDir) => {
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(path.join(agentDir, "AGENTS.md"), "old agents\n");
			writeFileSync(path.join(agentDir, "settings.json"), '{"old":true}\n');
			writeFileSync(
				path.join(agentDir, "keybindings.json"),
				'{"oldKeys":true}\n',
			);
			const remote = snapshot([
				{ path: "settings.json", content: Buffer.from('{"new":true}\n') },
				{
					path: "keybindings.json",
					content: Buffer.from('{"newKeys":true}\n'),
				},
			]);
			const originalRm = fs.rm;
			const originalWriteFile = fs.writeFile;
			let injected = false;
			fs.rm = (async (...args: Parameters<typeof fs.rm>) => {
				if (
					!injected &&
					boundary.method === "rm" &&
					String(args[0]) === path.join(agentDir, boundary.file)
				) {
					injected = true;
					throw new Error(
						`injected ${boundary.method} failure at ${boundary.file}`,
					);
				}
				return originalRm(...args);
			}) as typeof fs.rm;
			fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
				if (
					!injected &&
					boundary.method === "writeFile" &&
					String(args[0]).startsWith(
						`${path.join(agentDir, boundary.file)}.sync-`,
					)
				) {
					injected = true;
					throw new Error(
						`injected ${boundary.method} failure at ${boundary.file}`,
					);
				}
				return originalWriteFile(...args);
			}) as typeof fs.writeFile;
			try {
				await assert.rejects(
					applySnapshot(remote, new Set(), {
						syncFiles: ["AGENTS.md", "settings.json", "keybindings.json"],
						extraFiles: [],
					}),
					/injected .* failure/,
				);
			} finally {
				fs.rm = originalRm;
				fs.writeFile = originalWriteFile;
			}
			assert.equal(injected, true);
			assert.equal(
				readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"),
				"old agents\n",
			);
			assert.equal(
				readFileSync(path.join(agentDir, "settings.json"), "utf8"),
				'{"old":true}\n',
			);
			assert.equal(
				readFileSync(path.join(agentDir, "keybindings.json"), "utf8"),
				'{"oldKeys":true}\n',
			);
		});
	}
});

test("snapshot apply leaves unselected local files and directories untouched", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(path.join(agentDir, "skills"), { recursive: true });
		writeFileSync(path.join(agentDir, "keybindings.json"), "local keys\n");
		writeFileSync(path.join(agentDir, "skills", "local.md"), "local skill\n");
		const remote = snapshot([
			{ path: "settings.json", content: Buffer.from("remote settings\n") },
		]);

		await applySnapshot(remote, new Set(), {
			syncFiles: ["settings.json"],
			extraFiles: [],
		});

		assert.equal(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
			"remote settings\n",
		);
		assert.equal(
			readFileSync(path.join(agentDir, "keybindings.json"), "utf8"),
			"local keys\n",
		);
		assert.equal(
			readFileSync(path.join(agentDir, "skills", "local.md"), "utf8"),
			"local skill\n",
		);
	});
});

test("snapshot apply replaces a configured custom file with a remote directory", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "custom"), "local file\n");
		const remote = snapshot([
			{ path: "custom/child.txt", content: Buffer.from("remote child\n") },
		]);

		await applySnapshot(remote, new Set(), { include: ["custom"] });

		assert.deepEqual(readdirSync(path.join(agentDir, "custom")), ["child.txt"]);
		assert.equal(
			readFileSync(path.join(agentDir, "custom", "child.txt"), "utf8"),
			"remote child\n",
		);
	});
});

test("snapshot apply restores a custom file when directory replacement fails", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const customPath = path.join(agentDir, "custom");
		const childPath = path.join(customPath, "child.txt");
		writeFileSync(customPath, "local file\n");
		const remote = snapshot([
			{ path: "custom/child.txt", content: Buffer.from("remote child\n") },
		]);
		const originalWriteFile = fs.writeFile;
		fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
			if (String(args[0]).startsWith(`${childPath}.sync-`))
				throw new Error("injected custom child failure");
			return originalWriteFile(...args);
		}) as typeof fs.writeFile;
		try {
			await assert.rejects(
				applySnapshot(remote, new Set(), { include: ["custom"] }),
				/injected custom child failure/u,
			);
		} finally {
			fs.writeFile = originalWriteFile;
		}
		assert.equal(readFileSync(customPath, "utf8"), "local file\n");
	});
});

test("snapshot apply deletes stale top-level case variants", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-sync-apply-case-"));
	writeFileSync(path.join(root, "append_system.md"), "old\n");
	const remote = snapshot([
		{ path: "APPEND_SYSTEM.md", content: Buffer.from("new\n") },
	]);
	const current = snapshot([
		{ path: "APPEND_SYSTEM.md", content: Buffer.from("old\n") },
	]);
	const plan = preflightSnapshotApply(root, remote, current);
	assert.deepEqual(plan.deletes, []);

	const withCaseDeletes = await addTopLevelCaseVariantDeletes(
		root,
		plan,
		remote,
	);
	assert.deepEqual(withCaseDeletes.deletes, [
		path.join(root, "append_system.md"),
	]);

	const directoryRoot = mkdtempSync(
		path.join(os.tmpdir(), "pi-sync-apply-case-dir-"),
	);
	mkdirSync(path.join(directoryRoot, "append_system.md"));
	const directoryPlan = preflightSnapshotApply(directoryRoot, remote, current);
	const withoutDirectoryDelete = await addTopLevelCaseVariantDeletes(
		directoryRoot,
		directoryPlan,
		remote,
	);
	assert.deepEqual(withoutDirectoryDelete.deletes, []);
});

test("snapshot preflight failure leaves missing parent directories absent", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(path.join(agentDir, "existing"), { recursive: true });
		const remote = snapshot([
			{ path: "new/nested/file.md", content: Buffer.from("new") },
			{
				path: "existing",
				content: Buffer.from("cannot replace unselected directory"),
			},
		]);
		await assert.rejects(
			applySnapshot(remote, new Set(), { include: ["new", "existing"] }),
			/Refusing to overwrite directory/u,
		);
		assert.equal(existsSync(path.join(agentDir, "new")), false);
		assert.deepEqual(readdirSync(path.join(agentDir, "existing")), []);
	});
});

test("snapshot rollback removes new parent directories after a late write failure", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), '{"old":true}');
		const remote = snapshot([
			{ path: "new/nested/file.md", content: Buffer.from("new") },
			{ path: "settings.json", content: Buffer.from('{"new":true}') },
		]);
		const writeFile = fs.writeFile.bind(fs);
		const spy = vi
			.spyOn(fs, "writeFile")
			.mockImplementation(async (...args) => {
				if (
					String(args[0]).startsWith(
						`${path.join(agentDir, "settings.json")}.sync-`,
					)
				)
					throw new Error("injected late write failure");
				return writeFile(...args);
			});
		try {
			await assert.rejects(
				applySnapshot(remote, new Set(), { include: ["new", "settings.json"] }),
				/injected late write failure/u,
			);
		} finally {
			spy.mockRestore();
		}
		assert.equal(existsSync(path.join(agentDir, "new")), false);
		assert.equal(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
			'{"old":true}',
		);
	});
});

for (const failDeferredCheck of [false, true]) {
	test(`snapshot file ancestor replacement rechecks descendants and ${failDeferredCheck ? "rolls back" : "applies"}`, async () => {
		await withTempHome(async (agentDir) => {
			mkdirSync(agentDir, { recursive: true });
			const ancestor = path.join(agentDir, "custom.md");
			writeFileSync(ancestor, "original file ancestor");
			const remote = snapshot([
				{ path: "custom.md/nested/file.md", content: Buffer.from("remote") },
			]);
			const lstat = fs.lstat.bind(fs);
			let deferredChecks = 0;
			const spy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
				if (String(args[0]) === ancestor && !existsSync(ancestor)) {
					deferredChecks += 1;
					if (failDeferredCheck)
						throw Object.assign(
							new Error("injected deferred preflight failure"),
							{ code: "EACCES" },
						);
				}
				return lstat(...args);
			});
			try {
				const applying = applySnapshot(remote, new Set(), {
					include: ["custom.md"],
				});
				if (failDeferredCheck)
					await assert.rejects(
						applying,
						/injected deferred preflight failure/u,
					);
				else await applying;
			} finally {
				spy.mockRestore();
			}
			assert.ok(deferredChecks > 0);
			if (failDeferredCheck)
				assert.equal(readFileSync(ancestor, "utf8"), "original file ancestor");
			else
				assert.equal(
					readFileSync(path.join(ancestor, "nested/file.md"), "utf8"),
					"remote",
				);
		});
	});
}

test("snapshot rollback removes a newly created external session root", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const sessionDir = path.join(path.dirname(agentDir), "external-sessions");
		writeFileSync(path.join(agentDir, "settings.json"), '{"old":true}');
		const remote = snapshot([
			{ path: "sessions/project/session.jsonl", content: Buffer.from("{}\n") },
			{ path: "settings.json", content: Buffer.from('{"new":true}') },
		]);
		const writeFile = fs.writeFile.bind(fs);
		const spy = vi
			.spyOn(fs, "writeFile")
			.mockImplementation(async (...args) => {
				if (
					String(args[0]).startsWith(
						`${path.join(agentDir, "settings.json")}.sync-`,
					)
				)
					throw new Error("injected late write failure");
				return writeFile(...args);
			});
		try {
			await assert.rejects(
				applySnapshot(remote, new Set(), {
					include: ["sessions", "settings.json"],
					sessionDir,
				}),
				/injected late write failure/u,
			);
		} finally {
			spy.mockRestore();
		}
		assert.equal(existsSync(sessionDir), false);
		assert.equal(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
			'{"old":true}',
		);
	});
});
