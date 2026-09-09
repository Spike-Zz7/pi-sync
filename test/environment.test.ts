import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import {
	loadConfig,
	localConfigPath,
	readStateForConfig,
	updateSyncSetup,
} from "../src/config.js";
import {
	captureEnvironment,
	collectPortableDirectory,
	contentFile,
	digest,
	type EnvironmentInstaller,
	prepareEnvironment,
	requireEnvironment,
} from "../src/environment.js";
import { createSnapshot } from "../src/snapshot.js";
import { pull, push, syncBoth } from "../src/sync-operations.js";
import { bindSharedPolicy } from "../src/sync-setup.js";
import { fileHashMap } from "../src/sync-state.js";
import type { CommandOptions, Snapshot } from "../src/types.js";
import { snapshot, v3GitSettings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { createMockContext } from "./support.js";

const options: CommandOptions = {
	yes: true,
	force: false,
	auto: false,
	silent: false,
	reload: false,
	stale: false,
	args: [],
};
async function write(root: string, name: string, value: string) {
	const destination = path.join(root, name);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.writeFile(destination, value);
}
async function configure(root: string, include = ["settings.json", "skills"]) {
	await write(root, "pi-sync.json", JSON.stringify(v3GitSettings({ include })));
}
const pkg = {
	name: "pi-subagents",
	version: "1.2.3",
	pi: {
		extensions: ["./index.ts"],
		skills: ["./skills"],
		prompts: ["./prompts"],
	},
};
async function installFixture(root: string, version = "1.2.3") {
	await write(
		root,
		"node_modules/pi-subagents/package.json",
		JSON.stringify({ ...pkg, version }),
	);
	await write(
		root,
		"node_modules/pi-subagents/index.ts",
		"export default function () {}\n",
	);
	await write(
		root,
		"node_modules/pi-subagents/skills/pi-subagents/SKILL.md",
		"---\nname: pi-subagents\ndescription: Delegate tasks\n---\n# Skill\n",
	);
	await write(root, "node_modules/pi-subagents/prompts/plan.md", "Plan\n");
}
function installer(version = "1.2.3"): EnvironmentInstaller {
	return {
		npm: (root) => installFixture(root, version),
		git: async () => {
			throw new Error("unexpected Git install");
		},
	};
}
async function npmSnapshot(root: string) {
	await configure(root);
	await write(
		root,
		"settings.json",
		JSON.stringify({ packages: ["npm:pi-subagents"] }),
	);
	await write(
		root,
		"npm/package.json",
		JSON.stringify({ dependencies: { "pi-subagents": "1.2.3" } }),
	);
	await write(
		root,
		"npm/package-lock.json",
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": { dependencies: { "pi-subagents": "1.2.3" } },
				"node_modules/pi-subagents": {
					name: "pi-subagents",
					version: "1.2.3",
					resolved:
						"https://registry.npmjs.org/pi-subagents/-/pi-subagents-1.2.3.tgz",
					integrity: "sha512-fixture",
				},
			},
		}),
	);
	await installFixture(path.join(root, "npm"));
	return createSnapshot((await loadConfig()).snapshotIdentity, {
		include: ["settings.json", "skills"],
		strictEnvironment: true,
	});
}

test("strict environment pins installed npm version and restores package-provided skills without loose duplicates", async () => {
	await withTempHome(async (root) => {
		const remote = await npmSnapshot(root);
		const env = requireEnvironment(remote);
		if (!env) throw new Error("missing env");
		assert.equal(env.packages[0].source, "npm:pi-subagents@1.2.3");
		assert.equal(
			remote.files.some((f) => f.path.startsWith("skills/")),
			false,
		);
		const receiver = path.join(root, "receiver");
		const materialized = await prepareEnvironment(
			remote,
			receiver,
			installer(),
		);
		const settings = JSON.parse(
			Buffer.from(
				materialized.files.find((f) => f.path === "settings.json")
					?.contentBase64 ?? "",
				"base64",
			).toString(),
		);
		assert.match(settings.packages[0], /^\.\/pi-sync\/environments\//u);
		const packageRoot = path.resolve(receiver, settings.packages[0]);
		await fs.access(path.join(packageRoot, "skills/pi-subagents/SKILL.md"));
		await fs.access(path.join(packageRoot, "index.ts"));
		await write(receiver, "settings.json", JSON.stringify(settings));
		const roundtrip = await captureEnvironment(
			{ ...remote, files: materialized.files },
			receiver,
		);
		assert.deepEqual(fileHashMap(roundtrip), fileHashMap(remote));
	});
});

test("wrong-version install and transport failure preserve settings and baseline; retry activates exact version", async () => {
	await withTempHome(async (root) => {
		const remote = await npmSnapshot(root);
		const backend = new MemorySyncBackend();
		await backend.publishSnapshot(remote, { kind: "missing" });
		await fs.rm(path.join(root, "npm"), { recursive: true });
		await write(root, "settings.json", "{}\n");
		const before = await fs.readFile(path.join(root, "settings.json"));
		const { ctx, notifications } = createMockContext();
		for (const dependency of [
			installer("9.9.9"),
			{
				...installer(),
				npm: async () => {
					throw new Error("offline");
				},
			},
		]) {
			await assert.rejects(
				syncBoth(ctx, options, () => backend, dependency),
				/installation failed/u,
			);
			assert.deepEqual(
				await fs.readFile(path.join(root, "settings.json")),
				before,
			);
			assert.equal(
				(await readStateForConfig(await loadConfig())).lastAppliedSnapshot,
				undefined,
			);
			assert.equal(
				notifications.some((n) => /Pulled|synced\./u.test(n.message)),
				false,
			);
		}
		await syncBoth(ctx, options, () => backend, installer());
		assert.equal(
			(await readStateForConfig(await loadConfig())).lastAppliedSnapshot,
			remote.id,
		);
		const settings = JSON.parse(
			await fs.readFile(path.join(root, "settings.json"), "utf8"),
		);
		const packagePath = path.resolve(root, settings.packages[0]);
		await fs.rm(path.join(packagePath, "package.json"));
		await syncBoth(ctx, options, () => backend, installer());
		const repaired = JSON.parse(
			await fs.readFile(path.join(root, "settings.json"), "utf8"),
		);
		assert.notEqual(repaired.packages[0], settings.packages[0]);
		assert.equal(
			JSON.parse(
				await fs.readFile(
					path.resolve(root, repaired.packages[0], "package.json"),
					"utf8",
				),
			).version,
			"1.2.3",
		);
		await push(ctx, options, undefined, () => backend, installer());
		const published = await backend.readSnapshot(
			(await backend.readHead())?.snapshotRef ?? "",
		);
		assert.deepEqual(fileHashMap(published), fileHashMap(remote));
	});
});

test("local package bundles are portable and source tree remains untouched", async () => {
	await withTempHome(async (root) => {
		const source = path.join(root, "outside", "plugin");
		await write(
			source,
			"package.json",
			JSON.stringify({
				name: "local-plugin",
				pi: { extensions: ["./index.ts"] },
			}),
		);
		await write(source, "index.ts", "export default function () {}\n");
		await write(source, "assets/template.txt", "asset\n");
		await configure(root);
		await write(root, "settings.json", JSON.stringify({ packages: [source] }));
		const remote = await createSnapshot("default", {
			include: ["settings.json"],
			strictEnvironment: true,
		});
		assert.equal(JSON.stringify(remote).includes(source), false);
		const receiver = path.join(root, "receiver");
		const materialized = await prepareEnvironment(
			remote,
			receiver,
			installer(),
		);
		const settings = JSON.parse(
			Buffer.from(
				materialized.files.find((f) => f.path === "settings.json")
					?.contentBase64 ?? "",
				"base64",
			).toString(),
		);
		await fs.access(
			path.resolve(receiver, settings.packages[0], "assets/template.txt"),
		);
		await write(receiver, "settings.json", JSON.stringify(settings));
		const roundtrip = await captureEnvironment(
			{ ...remote, files: materialized.files },
			receiver,
		);
		assert.deepEqual(fileHashMap(roundtrip), fileHashMap(remote));
		assert.equal(
			await fs.readFile(path.join(source, "assets/template.txt"), "utf8"),
			"asset\n",
		);
	});
});

test("skill symlink roots include assets and executable modes; escapes and cycles fail closed", async () => {
	await withTempHome(async (root) => {
		const source = path.join(root, "shared-skill");
		await write(source, "SKILL.md", "skill\n");
		await write(source, "scripts/run.sh", "#!/bin/sh\nexit 0\n");
		await fs.chmod(path.join(source, "scripts/run.sh"), 0o755);
		await fs.mkdir(path.join(root, "skills"));
		await fs.symlink(source, path.join(root, "skills/demo"));
		const remote = await createSnapshot("default", {
			include: ["skills"],
			strictEnvironment: true,
		});
		assert.equal(
			remote.files.find((f) => f.path === "skills/demo/scripts/run.sh")?.mode,
			0o755,
		);
		await fs.symlink(source, path.join(source, "cycle"));
		await assert.rejects(
			collectPortableDirectory(source, "skills/demo"),
			/cycle/u,
		);
		await fs.unlink(path.join(source, "cycle"));
		await fs.symlink(path.dirname(source), path.join(source, "escape"));
		await assert.rejects(
			collectPortableDirectory(source, "skills/demo"),
			/escaping/u,
		);
	});
});

test("binding adopts shared policy; clean receiver applies custom skill files and rejects stale binding", async () => {
	await withTempHome(async (root) => {
		await configure(root, ["settings.json"]);
		const remote: Snapshot = {
			...snapshot([
				{ path: "skills/demo/SKILL.md", content: Buffer.from("skill") },
			]),
			version: 2,
			selection: { version: 1, include: ["skills"] },
		};
		remote.files.push(
			contentFile(
				"sync-environment.json",
				Buffer.from('{"version":1,"packages":[]}'),
			),
		);
		const backend = new MemorySyncBackend();
		await backend.publishSnapshot(remote, { kind: "missing" });
		await bindSharedPolicy("home", undefined, () => backend);
		assert.deepEqual((await loadConfig()).include, ["skills"]);
		const { ctx } = createMockContext();
		await syncBoth(ctx, options, () => backend, installer());
		assert.equal(
			await fs.readFile(path.join(root, "skills/demo/SKILL.md"), "utf8"),
			"skill",
		);
		const readHead = backend.readHead.bind(backend);
		let reads = 0;
		backend.readHead = async () => {
			const head = await readHead();
			return ++reads === 2 && head ? { ...head, revision: "stale" } : head;
		};
		await assert.rejects(
			bindSharedPolicy("home", undefined, () => backend),
			/Remote changed/u,
		);
	});
});

test("withdrawal removes only previously managed paths, preserves never-managed siblings, and detects modified ownership", async () => {
	await withTempHome(async (root) => {
		await configure(root, ["skills", "AGENTS.md"]);
		await write(root, "skills/demo/SKILL.md", "owned");
		await write(root, "AGENTS.md", "base");
		const backend = new MemorySyncBackend();
		const { ctx } = createMockContext();
		await syncBoth(ctx, options, () => backend, installer());
		await write(root, "skills/never/SKILL.md", "never managed");
		await updateSyncSetup("home", (setup) => ({
			...setup,
			sync: { ...setup.sync, include: ["AGENTS.md"] },
		}));
		await syncBoth(ctx, options, () => backend, installer());
		await assert.rejects(
			fs.access(path.join(root, "skills/demo/SKILL.md")),
			/ENOENT/u,
		);
		assert.equal(
			await fs.readFile(path.join(root, "skills/never/SKILL.md"), "utf8"),
			"never managed",
		);
		const published = await backend.readSnapshot(
			(await backend.readHead())?.snapshotRef ?? "",
		);
		assert.equal(
			published.files.some((f) => f.path.startsWith("skills/")),
			false,
		);
	});
});

test("install-success/apply-failure rolls settings and policy back and retry reuses staged environment", async () => {
	await withTempHome(async (root) => {
		const remote = await npmSnapshot(root);
		const backend = new MemorySyncBackend();
		await backend.publishSnapshot(remote, { kind: "missing" });
		await configure(root, ["AGENTS.md"]);
		await write(root, "settings.json", "{}\n");
		const before = await fs.readFile(localConfigPath());
		const { ctx } = createMockContext();
		const writeFile = fs.writeFile;
		let injected = false;
		fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
			if (
				!injected &&
				String(args[0]).startsWith(`${localConfigPath()}.sync-`)
			) {
				injected = true;
				throw new Error("injected apply failure");
			}
			return writeFile(...args);
		}) as typeof fs.writeFile;
		try {
			await assert.rejects(
				pull(ctx, { ...options, force: true }, () => backend, installer()),
				/injected apply failure/u,
			);
		} finally {
			fs.writeFile = writeFile;
		}
		assert.deepEqual(await fs.readFile(localConfigPath()), before);
		assert.equal(
			await fs.readFile(path.join(root, "settings.json"), "utf8"),
			"{}\n",
		);
		assert.equal(
			(await readStateForConfig(await loadConfig())).lastAppliedSnapshot,
			undefined,
		);
		await pull(ctx, { ...options, force: true }, () => backend, {
			...installer(),
			npm: async () => {
				throw new Error("should reuse verified staging");
			},
		});
		assert.deepEqual((await loadConfig()).include, ["settings.json", "skills"]);
	});
});

test("strict malformed snapshots reject paths, modes, checksums, duplicate paths and unpinned package sources", async () => {
	await withTempHome(async (root) => {
		const base = await npmSnapshot(root);
		for (const mutate of [
			(s: Snapshot) => {
				s.files.push(contentFile("../escape", Buffer.from("bad")));
			},
			(s: Snapshot) => {
				s.files[0].mode = 0o777;
			},
			(s: Snapshot) => {
				s.files[0].sha256 = digest("wrong");
			},
			(s: Snapshot) => {
				s.files.push(s.files[0]);
			},
			(s: Snapshot) => {
				const f = s.files.find((f) => f.path === "sync-environment.json");
				if (!f) throw new Error("missing");
				const env = JSON.parse(
					Buffer.from(f.contentBase64, "base64").toString(),
				);
				env.packages[0].source = "npm:pi-subagents@latest";
				Object.assign(f, contentFile(f.path, Buffer.from(JSON.stringify(env))));
			},
		]) {
			const value = structuredClone(base);
			mutate(value);
			assert.throws(() => requireEnvironment(value));
		}
		const legacy = { ...base, version: 1 };
		assert.throws(() => requireEnvironment(legacy), /Reserved/u);
	});
});

test("explicit external global skills/assets become portable managed resources and roundtrip", async () => {
	await withTempHome(async (root) => {
		const external = path.join(path.dirname(root), "external-skill");
		await write(external, "SKILL.md", "external skill");
		await write(external, "references/guide.md", "guide");
		await write(root, "settings.json", JSON.stringify({ skills: [external] }));
		const remote = await createSnapshot("default", {
			include: ["settings.json", "skills"],
			strictEnvironment: true,
		});
		assert.equal(JSON.stringify(remote).includes(external), false);
		const receiver = path.join(root, "receiver");
		const materialized = await prepareEnvironment(
			remote,
			receiver,
			installer(),
		);
		const settings = JSON.parse(
			Buffer.from(
				materialized.files.find((f) => f.path === "settings.json")
					?.contentBase64 ?? "",
				"base64",
			).toString(),
		);
		assert.equal(
			await fs.readFile(
				path.resolve(receiver, settings.skills[0], "references/guide.md"),
				"utf8",
			),
			"guide",
		);
		await write(receiver, "settings.json", JSON.stringify(settings));
		assert.deepEqual(
			fileHashMap(
				await captureEnvironment(
					{ ...remote, files: materialized.files },
					receiver,
				),
			),
			fileHashMap(remote),
		);
		await write(
			root,
			"settings.json",
			JSON.stringify({ skills: ["skills/*"] }),
		);
		await assert.rejects(
			createSnapshot("default", {
				include: ["settings.json"],
				strictEnvironment: true,
			}),
			/globs\/filters/u,
		);
	});
});

test("Git packages pin observed full commit and verify receiver checkout without live transport", async () => {
	const { runGit } = await import("../src/git-runner.js");
	await withTempHome(async (root) => {
		const git = path.join(root, "git/example.com/owner/plugin");
		await write(
			git,
			"package.json",
			JSON.stringify({ name: "git-plugin", pi: { extensions: ["index.ts"] } }),
		);
		await write(git, "index.ts", "export default function() {}\n");
		await runGit(["init", "--initial-branch=main"], { cwd: git });
		await runGit(["add", "--", "package.json", "index.ts"], { cwd: git });
		await runGit(
			[
				"-c",
				"user.name=fixture",
				"-c",
				"user.email=fixture@example.test",
				"commit",
				"-m",
				"fixture",
			],
			{ cwd: git },
		);
		const commit = (await runGit(["rev-parse", "HEAD"], { cwd: git })).stdout
			.toString()
			.trim();
		await write(
			root,
			"settings.json",
			JSON.stringify({
				packages: ["git:https://example.com/owner/plugin@main"],
			}),
		);
		const remote = await createSnapshot("default", {
			include: ["settings.json"],
			strictEnvironment: true,
		});
		assert.equal(
			requireEnvironment(remote)?.packages[0].source,
			`git:https://example.com/owner/plugin@${commit}`,
		);
		const receiver = path.join(root, "receiver");
		const dependency: EnvironmentInstaller = {
			...installer(),
			git: async (url, revision, directory) => {
				assert.equal(url, "https://example.com/owner/plugin");
				assert.equal(revision, commit);
				await fs.cp(git, directory, { recursive: true });
			},
		};
		const materialized = await prepareEnvironment(remote, receiver, dependency);
		await write(
			receiver,
			"settings.json",
			Buffer.from(
				materialized.files.find((f) => f.path === "settings.json")
					?.contentBase64 ?? "",
				"base64",
			).toString(),
		);
		assert.deepEqual(
			fileHashMap(
				await captureEnvironment(
					{ ...remote, files: materialized.files },
					receiver,
				),
			),
			fileHashMap(remote),
		);
		await write(git, "index.ts", "modified");
		await assert.rejects(
			createSnapshot("default", {
				include: ["settings.json"],
				strictEnvironment: true,
			}),
			/modified/u,
		);
	});
});

test("interrupted settings/policy activation journal recovers before retry without installing in live roots", async () => {
	const { recoverPendingSnapshotTransactions } = await import(
		"../src/snapshot-transaction.js"
	);
	await withTempHome(async (root) => {
		await configure(root, ["AGENTS.md"]);
		await write(root, "settings.json", '{"theme":"original"}\n');
		const priorConfig = await fs.readFile(localConfigPath());
		const priorSettings = await fs.readFile(path.join(root, "settings.json"));
		const transaction = path.join(root, "pi-sync/transactions/interrupted");
		await write(transaction, "before/0", priorConfig.toString());
		await write(transaction, "before/1", priorSettings.toString());
		await write(
			transaction,
			"journal.json",
			JSON.stringify({
				version: 1,
				root,
				entries: [
					{
						target: localConfigPath(),
						backupName: "0",
						kind: "file",
						mode: 0o600,
					},
					{
						target: path.join(root, "settings.json"),
						backupName: "1",
						kind: "file",
						mode: 0o600,
					},
				],
			}),
		);
		await configure(root, ["settings.json", "skills"]);
		await write(
			root,
			"settings.json",
			'{"packages":["./pi-sync/environments/incomplete"]}\n',
		);
		await recoverPendingSnapshotTransactions();
		assert.deepEqual(await fs.readFile(localConfigPath()), priorConfig);
		assert.deepEqual(
			await fs.readFile(path.join(root, "settings.json")),
			priorSettings,
		);
		assert.equal(
			(await readStateForConfig(await loadConfig())).lastAppliedSnapshot,
			undefined,
		);
		await assert.rejects(fs.access(transaction), /ENOENT/u);
	});
});

test("Windows subprocess resolution and process-tree termination", async () => {
	const { resolveNpmCommand, resolveNpmInvocation, runNpm } = await import(
		"../src/environment-installer.js"
	);

	// 1. Command resolution on Unix falls back to npm when npm-cli.js not found
	assert.equal(
		resolveNpmInvocation({ platform: "linux", fsExists: () => false }).command,
		"npm",
	);
	assert.equal(
		resolveNpmInvocation({ platform: "darwin", fsExists: () => false }).command,
		"npm",
	);

	// 2. Resolver on Windows locates npm-cli.js beside node.exe, including paths with spaces
	const winNode = "C:\\Program Files\\nodejs\\node.exe";
	const winNpmCli =
		"C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
	const resolvedWin = resolveNpmInvocation({
		platform: "win32",
		execPath: winNode,
		fsExists: (p) => p === winNpmCli,
	});
	assert.equal(resolvedWin.command, winNode);
	assert.deepEqual(resolvedWin.argsPrefix, [winNpmCli]);
	assert.equal(resolveNpmCommand(), process.execPath);

	// 3. Resolver on Windows in PATH directories with spaces and metacharacters
	const customCli = "D:\\Tools & Utilities\\node_modules\\npm\\bin\\npm-cli.js";
	const fromPath = resolveNpmInvocation({
		platform: "win32",
		execPath: "D:\\custom\\node.exe",
		env: { Path: "D:\\Tools & Utilities;C:\\Windows" },
		fsExists: (p) => p === customCli,
	});
	assert.equal(fromPath.command, "D:\\custom\\node.exe");
	assert.deepEqual(fromPath.argsPrefix, [customCli]);

	// 4. Resolver on Windows fails explicitly when npm-cli.js cannot be found
	assert.throws(
		() =>
			resolveNpmInvocation({
				platform: "win32",
				execPath: "C:\\standalone\\node.exe",
				env: { Path: "" },
				fsExists: () => false,
			}),
		/Unable to locate npm-cli.js on Windows/u,
	);

	// 5. Execution passing spaces and metacharacters as data with shell: false
	const spawned: Array<{
		command: string;
		args: string[];
		options: { shell?: boolean; cwd?: string };
	}> = [];
	const fakeChild = Object.assign(new EventEmitter(), {
		pid: 12345,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(),
	}) as unknown as ChildProcess;

	const mockSpawn = ((
		command: string,
		args: string[],
		spawnOpts: { shell?: boolean; cwd?: string },
	) => {
		spawned.push({ command, args, options: spawnOpts });
		if (command === "taskkill") {
			const taskkillChild = Object.assign(new EventEmitter(), {
				unref: vi.fn(),
			}) as unknown as ChildProcess;
			return taskkillChild;
		}
		setTimeout(() => fakeChild.emit("close", 1), 10);
		return fakeChild;
	}) as typeof import("node:child_process").spawn;

	const controller = new AbortController();
	const complexArgs = [
		"ci",
		"--prefix=C:\\Program Files (x86)\\My App & Tools",
		"--tag=v1.0.0|beta&release",
		"--user=user@domain.test",
	];
	const running = runNpm(complexArgs, "/fake/dir", {
		platform: "win32",
		execPath: winNode,
		fsExists: (p) => p === winNpmCli,
		signal: controller.signal,
		spawnFn: mockSpawn,
	});
	controller.abort();
	await assert.rejects(running, /cancelled/i);

	assert.equal(spawned[0].command, winNode);
	assert.equal(spawned[0].options.shell, false);
	assert.deepEqual(spawned[0].args, [winNpmCli, ...complexArgs]);
	assert.ok(
		spawned.some((s) => s.command === "taskkill" && s.args.includes("12345")),
	);
});

test("coexistence of managed generations and fresh local package installs with object form and filters", async () => {
	await withTempHome(async (root) => {
		const remote = await npmSnapshot(root);
		const receiver = path.join(root, "receiver");
		const materialized = await prepareEnvironment(
			remote,
			receiver,
			installer(),
		);
		const initialSettings = JSON.parse(
			Buffer.from(
				materialized.files.find((f) => f.path === "settings.json")
					?.contentBase64 ?? "",
				"base64",
			).toString(),
		);
		await write(receiver, "settings.json", JSON.stringify(initialSettings));

		await installFixture(path.join(receiver, "npm"), "2.0.0");
		await write(
			receiver,
			"npm/node_modules/second-plugin/package.json",
			JSON.stringify({
				name: "second-plugin",
				version: "2.0.0",
				pi: { extensions: ["./index.ts"] },
			}),
		);
		await write(
			receiver,
			"npm/node_modules/second-plugin/index.ts",
			"export default function () {}\n",
		);
		await write(
			receiver,
			"npm/package.json",
			JSON.stringify({
				dependencies: {
					"pi-subagents": "1.2.3",
					"second-plugin": "2.0.0",
				},
			}),
		);
		await write(
			receiver,
			"npm/package-lock.json",
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"": {
						dependencies: {
							"pi-subagents": "1.2.3",
							"second-plugin": "2.0.0",
						},
					},
					"node_modules/pi-subagents": {
						name: "pi-subagents",
						version: "1.2.3",
						resolved:
							"https://registry.npmjs.org/pi-subagents/-/pi-subagents-1.2.3.tgz",
						integrity: "sha512-fixture",
					},
					"node_modules/second-plugin": {
						name: "second-plugin",
						version: "2.0.0",
						resolved:
							"https://registry.npmjs.org/second-plugin/-/second-plugin-2.0.0.tgz",
						integrity: "sha512-second-fixture",
					},
				},
			}),
		);

		// Configure receiver with both the managed package and a fresh object-form npm package with filters
		const secondPackageDefinition = {
			source: "npm:second-plugin",
			extensions: ["+index.ts", "!legacy.ts"],
			skills: [],
		};
		await write(
			receiver,
			"settings.json",
			JSON.stringify({
				packages: [initialSettings.packages[0], secondPackageDefinition],
			}),
		);

		const captured = await captureEnvironment(
			{
				...remote,
				files: materialized.files.map((f) =>
					f.path === "settings.json"
						? contentFile(
								"settings.json",
								Buffer.from(
									JSON.stringify({
										packages: [
											initialSettings.packages[0],
											secondPackageDefinition,
										],
									}),
								),
							)
						: f,
				),
			},
			receiver,
		);

		const env = requireEnvironment(captured);
		assert.ok(env);
		assert.equal(env.packages.length, 2);
		assert.equal(env.packages[0].source, "npm:pi-subagents@1.2.3");
		assert.equal(env.packages[1].source, "npm:second-plugin@2.0.0");

		// Verify snapshot's settings.json retained the object form and its filters
		const capturedSettings = JSON.parse(
			Buffer.from(
				captured.files.find((f) => f.path === "settings.json")?.contentBase64 ??
					"",
				"base64",
			).toString(),
		);
		assert.deepEqual(capturedSettings.packages[1], {
			source: "npm:second-plugin@2.0.0",
			extensions: ["+index.ts", "!legacy.ts"],
			skills: [],
		});

		// Materialize on a second receiver to verify pull and filter retention
		const receiver2 = path.join(root, "receiver2");
		const dualInstaller: EnvironmentInstaller = {
			npm: async (dir) => {
				await installFixture(dir, "1.2.3");
				await write(
					dir,
					"node_modules/second-plugin/package.json",
					JSON.stringify({
						name: "second-plugin",
						version: "2.0.0",
						pi: { extensions: ["./index.ts"] },
					}),
				);
				await write(
					dir,
					"node_modules/second-plugin/index.ts",
					"export default function () {}\n",
				);
			},
			git: async () => {
				throw new Error("unexpected Git install");
			},
		};
		const secondMaterialized = await prepareEnvironment(
			captured,
			receiver2,
			dualInstaller,
		);
		const secondSettings = JSON.parse(
			Buffer.from(
				secondMaterialized.files.find((f) => f.path === "settings.json")
					?.contentBase64 ?? "",
				"base64",
			).toString(),
		);
		assert.match(
			secondSettings.packages[1].source,
			/^\.\/pi-sync\/environments\//,
		);
		assert.deepEqual(secondSettings.packages[1].extensions, [
			"+index.ts",
			"!legacy.ts",
		]);
		assert.deepEqual(secondSettings.packages[1].skills, []);
	});
});

test("preserves unmanaged sibling symlinks in skills/ during apply and replaces overwritten symlinks", async () => {
	const { applySnapshot } = await import("../src/snapshot-apply.ts");
	await withTempHome(async (root) => {
		const skillsDir = path.join(root, "skills");
		await fs.mkdir(skillsDir, { recursive: true });

		const unmanagedTarget = path.join(path.dirname(root), "unmanaged-tool");
		await write(unmanagedTarget, "SKILL.md", "# Unmanaged Skill\n");
		await fs.symlink(unmanagedTarget, path.join(skillsDir, "unmanaged-tool"));

		const willBeOverwrittenTarget = path.join(path.dirname(root), "old-tool");
		await write(willBeOverwrittenTarget, "SKILL.md", "# Old Tool\n");
		await fs.symlink(
			willBeOverwrittenTarget,
			path.join(skillsDir, "owned-skill"),
		);

		const incoming: Snapshot = {
			version: 2,
			id: "incoming-snap",
			createdAt: new Date().toISOString(),
			machine: "remote-host",
			profile: "default",
			selection: { version: 1, include: ["skills"] },
			files: [
				contentFile(
					"skills/owned-skill/SKILL.md",
					Buffer.from("# Managed Skill\n"),
				),
			],
		};

		await applySnapshot(incoming, new Set(), { include: ["skills"] });

		const unmanagedStat = await fs.lstat(
			path.join(skillsDir, "unmanaged-tool"),
		);
		assert.ok(unmanagedStat.isSymbolicLink());
		assert.equal(
			await fs.readlink(path.join(skillsDir, "unmanaged-tool")),
			unmanagedTarget,
		);
		assert.equal(
			await fs.readFile(
				path.join(skillsDir, "unmanaged-tool/SKILL.md"),
				"utf8",
			),
			"# Unmanaged Skill\n",
		);

		const ownedStat = await fs.lstat(path.join(skillsDir, "owned-skill"));
		assert.ok(ownedStat.isDirectory());
		assert.equal(
			await fs.readFile(path.join(skillsDir, "owned-skill/SKILL.md"), "utf8"),
			"# Managed Skill\n",
		);
	});
});
