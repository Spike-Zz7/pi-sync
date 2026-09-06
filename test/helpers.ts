import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockPath } from "../src/config.js";

export function writeOldLock(contents: string) {
	writeFileSync(lockPath(), contents);
	const old = new Date(Date.now() - 60_000);
	utimesSync(lockPath(), old, old);
}

export function snapshot(files: Array<{ path: string; content: Buffer }>) {
	return {
		version: 1,
		id: "snap",
		createdAt: "2026-01-01T00:00:00.000Z",
		machine: "test",
		profile: "default",
		files: files.map((file) => ({
			path: file.path,
			contentBase64: file.content.toString("base64"),
			sha256: createHash("sha256").update(file.content).digest("hex"),
		})),
	};
}

export function v3GitSettings(
	options: {
		automatic?: boolean;
		include?: string[];
		path?: string;
		branch?: string;
		skipSecretScan?: boolean;
	} = {},
) {
	return {
		version: 3,
		activeSyncSetup: "home",
		onSwitch: "ask-before-pull",
		skipSecretScan: options.skipSecretScan ?? false,
		storageConnections: {
			origin: {
				type: "git" as const,
				remote: "git@github.com:example/settings.git",
			},
		},
		syncSetups: {
			home: {
				storage: {
					connection: "origin",
					branch: options.branch ?? "main",
					path: options.path ?? "pi-sync/home",
				},
				sync: {
					include: options.include ?? ["settings.json"],
					automatic: options.automatic ?? false,
				},
			},
		},
	};
}

export function requiredConfig() {
	return {
		extraFiles: [],
	};
}

export async function withTempHome<T>(fn: (agentDir: string) => Promise<T>) {
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-home-"));
	const agentDir = path.join(home, ".pi", "agent");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
	try {
		return await fn(agentDir);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousSessionDir === undefined)
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
		rmSync(home, { recursive: true, force: true });
	}
}

export async function withEnv<T>(
	env: Record<string, string>,
	fn: () => Promise<T>,
) {
	const keys = [
		"PI_SYNC_SESSIONS",
		"PI_SYNC_PROFILE",
		"PI_SYNC_AUTO_SYNC",
		"PI_CODING_AGENT_DIR",
		"PI_CODING_AGENT_SESSION_DIR",
	];
	const previous = Object.fromEntries(
		keys.map((key) => [key, process.env[key]]),
	);
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	try {
		return await fn();
	} finally {
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
}
