import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { EnvironmentInstaller } from "./environment.js";
import { runGit } from "./git-runner.js";

/** Required lockfiles avoid resolving runtime dependency ranges differently on receivers. */
export const environmentInstaller: EnvironmentInstaller = {
	async npm(directory, signal) {
		const lock = JSON.parse(
			await fs.readFile(path.join(directory, "package-lock.json"), "utf8"),
		);
		if (![2, 3].includes(lock.lockfileVersion) || !lock.packages)
			throw new Error(
				"Strict package restoration requires a v2/v3 npm lockfile.",
			);
		for (const [name, raw] of Object.entries(lock.packages)) {
			const p = raw as {
				dev?: boolean;
				link?: boolean;
				resolved?: string;
				integrity?: string;
			};
			if (!name || p.dev === true) continue;
			if (p.link || !p.resolved?.startsWith("https://") || !p.integrity)
				throw new Error(
					"Dependency lock contains an unportable or unverifiable runtime dependency.",
				);
			const url = new URL(p.resolved);
			if (url.username || url.password)
				throw new Error("Credential-bearing dependency URL is not portable.");
		}
		await runNpm(
			["ci", "--omit=dev", "--ignore-scripts=false", "--no-audit", "--no-fund"],
			directory,
			{ signal },
		);
		await runNpm(["ls", "--omit=dev", "--all", "--json"], directory, {
			signal,
		});
	},
	async git(remote, commit, directory, signal) {
		await fs.mkdir(path.dirname(directory), { recursive: true });
		await runGit(["clone", "--no-checkout", "--", remote, directory], {
			signal,
			timeoutMs: 300_000,
		});
		await runGit(["checkout", "--detach", commit], { cwd: directory, signal });
	},
};

export interface NpmInvocation {
	command: string;
	argsPrefix: string[];
}

export interface ResolveNpmOptions {
	platform?: string;
	execPath?: string;
	env?: NodeJS.ProcessEnv;
	fsExists?: (path: string) => boolean;
}

export function resolveNpmInvocation(
	options: ResolveNpmOptions = {},
): NpmInvocation {
	const platform = options.platform ?? process.platform;
	const pathOps = platform === "win32" ? path.win32 : path.posix;
	const execPath = options.execPath ?? process.execPath;
	const env = options.env ?? process.env;
	const exists =
		options.fsExists ??
		((filePath: string) => {
			try {
				return fsSync.existsSync(filePath);
			} catch {
				return false;
			}
		});

	const npmExecPath = env.npm_execpath ?? env.NPM_EXECPATH;
	const candidates: string[] = [];
	if (npmExecPath) candidates.push(npmExecPath);
	const execDir = pathOps.dirname(execPath);
	candidates.push(
		pathOps.join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
		pathOps.resolve(
			execDir,
			"..",
			"lib",
			"node_modules",
			"npm",
			"bin",
			"npm-cli.js",
		),
	);
	const pathEnv = env.PATH ?? env.Path ?? "";
	if (pathEnv) {
		const delimiter = platform === "win32" ? ";" : pathOps.delimiter;
		for (const dir of pathEnv.split(delimiter)) {
			if (!dir) continue;
			candidates.push(
				pathOps.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
				pathOps.join(dir, "npm-cli.js"),
			);
		}
	}

	for (const candidate of candidates) {
		if (candidate && exists(candidate)) {
			return {
				command: execPath,
				argsPrefix: [candidate],
			};
		}
	}

	if (platform === "win32") {
		throw new Error(
			"Unable to locate npm-cli.js on Windows for safe shell:false execution. Automatic package installation requires a standard Node.js installation with npm-cli.js.",
		);
	}

	return {
		command: "npm",
		argsPrefix: [],
	};
}

export function resolveNpmCommand(platform: string = process.platform): string {
	try {
		return resolveNpmInvocation({ platform }).command;
	} catch {
		return platform === "win32" ? "npm.cmd" : "npm";
	}
}

export interface RunNpmOptions {
	signal?: AbortSignal;
	platform?: string;
	execPath?: string;
	env?: NodeJS.ProcessEnv;
	fsExists?: (path: string) => boolean;
	spawnFn?: typeof spawn;
	timeoutMs?: number;
	maxOutputBytes?: number;
}

export function runNpm(
	args: string[],
	cwd: string,
	options: RunNpmOptions = {},
): Promise<void> {
	options.signal?.throwIfAborted();
	const platform = options.platform ?? process.platform;
	const spawnChild = options.spawnFn ?? spawn;
	const timeoutMs = options.timeoutMs ?? 300_000;
	const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
	const invocation = resolveNpmInvocation({
		platform,
		execPath: options.execPath,
		env: options.env,
		fsExists: options.fsExists,
	});
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!/^(?:GIT_|NPM_CONFIG_|NODE_OPTIONS$|NODE_PATH$|SSH_ASKPASS|PAGER$|EDITOR$|VISUAL$)/iu.test(
					key,
				),
		),
	);
	const env = {
		...inherited,
		CI: "1",
		LC_ALL: "C",
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "Never",
		GIT_ASKPASS: "",
		SSH_ASKPASS: "",
		SSH_ASKPASS_REQUIRE: "never",
		GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
		GIT_PAGER: "cat",
		GIT_EDITOR: "true",
		PAGER: "cat",
		EDITOR: "true",
		VISUAL: "true",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: "4",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: platform === "win32" ? "NUL" : "/dev/null",
		GIT_CONFIG_KEY_1: "protocol.allow",
		GIT_CONFIG_VALUE_1: "never",
		GIT_CONFIG_KEY_2: "protocol.https.allow",
		GIT_CONFIG_VALUE_2: "always",
		GIT_CONFIG_KEY_3: "protocol.ssh.allow",
		GIT_CONFIG_VALUE_3: "always",
	};
	return new Promise((resolve, reject) => {
		const child = spawnChild(
			invocation.command,
			[...invocation.argsPrefix, ...args],
			{
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				windowsHide: true,
				detached: platform !== "win32",
			},
		);
		let size = 0;
		let failure: Error | undefined;
		let escalation: NodeJS.Timeout | undefined;
		const kill = (force: boolean) => {
			if (!child.pid) return;
			if (platform === "win32") {
				const killer = spawnChild(
					"taskkill",
					["/pid", String(child.pid), "/t", "/f"],
					{ stdio: "ignore", windowsHide: true },
				);
				killer.on("error", () => child.kill());
			} else {
				try {
					process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
				} catch {
					child.kill(force ? "SIGKILL" : "SIGTERM");
				}
			}
		};
		const terminate = (error: Error) => {
			if (failure) return;
			failure = error;
			kill(false);
			escalation = setTimeout(() => kill(true), 2_000);
		};
		const abort = () => terminate(new Error("Package installation cancelled."));
		const timer = setTimeout(
			() => terminate(new Error("Package installation timed out.")),
			timeoutMs,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		const consume = (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxOutputBytes)
				terminate(new Error("Package installer output limit exceeded."));
		};
		child.stdout?.on("data", consume);
		child.stderr?.on("data", consume);
		child.on("error", (error) => {
			failure = error;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (escalation) clearTimeout(escalation);
			options.signal?.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (code === 0) resolve();
			else
				reject(
					new Error(
						"Required npm installation/verification failed. Check the lockfile and registry access, then retry /sync.",
					),
				);
		});
	});
}
