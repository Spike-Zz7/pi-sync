import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import {
	configuredSyncSetupNames,
	effectiveSyncSetupRemoteIdentity,
	loadConfig,
	localConfigPath,
	normalizeSyncInclude,
	readLocalConfigObject,
	validateSettingsDocument,
} from "../src/config.js";
import {
	BUILT_IN_SYNC_ROOTS,
	isSafeCustomIncludePath,
} from "../src/sync-policy.js";
import { withTempHome } from "./helpers.js";

function connection() {
	return { type: "git" as const, remote: "git@github.com:user/pi-sync.git" };
}

function setup(name = "store") {
	return {
		storage: {
			connection: name,
			branch: "pi-sync/home",
			path: "pi-sync/home",
		},
		sync: {
			include: ["settings.json", "AGENTS.md", "sessions"],
			automatic: true,
		},
	};
}

function settings() {
	return {
		version: 3,
		activeSyncSetup: "home",
		onSwitch: "ask-before-pull" as const,
		storageConnections: { store: connection() },
		syncSetups: { home: setup() },
	};
}

async function writeSettings(agentDir: string, value: unknown) {
	assert.equal(localConfigPath(), path.join(agentDir, "pi-sync.json"));
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		path.join(agentDir, "pi-sync.json"),
		`${JSON.stringify(value, null, "\t")}\n`,
		{
			mode: 0o600,
		},
	);
}

test("version 3 resolves Git setup shape", async () => {
	await withTempHome(async (agentDir) => {
		await writeSettings(agentDir, settings());
		const config = await loadConfig();
		assert.equal(config.setupName, "home");
		assert.equal(config.connectionName, "store");
		assert.equal(config.backend.type, "git");
		assert.deepEqual(config.include, [
			"settings.json",
			"AGENTS.md",
			"sessions",
		]);
		assert.equal(config.automatic, true);
		assert.equal(config.skipSecretScan, false);
		assert.equal(config.storagePath, "pi-sync/home");
	});
});

test("version 3 rejects non-Git storage connection types", () => {
	for (const unsupportedType of ["custom", "unsupported"]) {
		const doc = settings();
		(doc.storageConnections.store as Record<string, unknown>).type =
			unsupportedType;
		assert.throws(
			() => effectiveValidated(doc),
			/unsupported type.*Only Git is supported/u,
		);
	}
});

test("version 3 validates the optional global secret-scan override", () => {
	const enabled = settings() as ReturnType<typeof settings> & {
		skipSecretScan?: unknown;
	};
	enabled.skipSecretScan = true;
	assert.equal(effectiveValidated(enabled), enabled);
	enabled.skipSecretScan = "true";
	assert.throws(
		() => effectiveValidated(enabled),
		/skipSecretScan must be boolean/u,
	);
});

test("version 3 accepts an empty catalog only without an active setup", async () => {
	await withTempHome(async (agentDir) => {
		const empty = {
			version: 3,
			onSwitch: "switch-only",
			storageConnections: {},
			syncSetups: {},
		};
		await writeSettings(agentDir, empty);
		assert.deepEqual(await readLocalConfigObject(), empty);
		assert.deepEqual(await configuredSyncSetupNames(), []);
		await assert.rejects(loadConfig(), /No sync setups are configured/u);
	});
});

test("version 3 rejects whitespace-normalized setup references", () => {
	const active = settings();
	active.activeSyncSetup = " home ";
	assert.throws(
		() => effectiveValidated(active),
		/activeSyncSetup.*whitespace/u,
	);

	const connectionReference = settings();
	connectionReference.syncSetups.home.storage.connection = " store ";
	assert.throws(
		() => effectiveValidated(connectionReference),
		/storage connection reference.*whitespace/u,
	);
});

test("version 3 rejects missing references and backend-field mixing", async () => {
	await withTempHome(async (agentDir) => {
		const missing = settings();
		missing.syncSetups.home.storage.connection = "missing";
		await writeSettings(agentDir, missing);
		await assert.rejects(loadConfig(), /missing storage connection/u);

		const mixed = settings() as ReturnType<typeof settings> & {
			syncSetups: { home: { storage: Record<string, unknown> } };
		};
		mixed.syncSetups.home.storage.bucket = "wrong";
		await writeSettings(agentDir, mixed);
		await assert.rejects(loadConfig(), /Git sync setup.*mixes backend fields/u);
	});
});

test("built-in sync roots stay canonical and cannot become custom paths", () => {
	for (const root of BUILT_IN_SYNC_ROOTS) {
		const caseVariant = root.toUpperCase();
		assert.deepEqual(normalizeSyncInclude([caseVariant]), [root]);
		assert.equal(isSafeCustomIncludePath(root), false, root);
		assert.equal(isSafeCustomIncludePath(caseVariant), false, caseVariant);
		assert.equal(
			isSafeCustomIncludePath(`${root}/child`),
			false,
			`${root}/child`,
		);
		assert.throws(
			() => normalizeSyncInclude([`${root}/child`]),
			/canonical .* root/u,
		);
		assert.equal(
			isSafeCustomIncludePath(`${root}.backup`),
			true,
			`${root}.backup`,
		);
	}
	assert.equal(isSafeCustomIncludePath("custom.json"), true);
	assert.equal(isSafeCustomIncludePath("custom"), true);
});

test("version 3 rejects reserved names, duplicate remotes, and invalid include values", async () => {
	await withTempHome(async (agentDir) => {
		const reserved = JSON.parse(JSON.stringify(settings())) as Record<
			string,
			unknown
		>;
		reserved.storageConnections = JSON.parse(
			`{"__proto__":${JSON.stringify(connection())}}`,
		) as Record<string, unknown>;
		await writeSettings(agentDir, reserved);
		await assert.rejects(
			readLocalConfigObject(),
			/invalid storage connection name/u,
		);

		const duplicate = settings();
		(duplicate.syncSetups as Record<string, ReturnType<typeof setup>>).backup =
			setup();
		await writeSettings(agentDir, duplicate);
		await assert.rejects(
			readLocalConfigObject(),
			/same normalized remote location/u,
		);

		assert.throws(
			() => normalizeSyncInclude(["settings.json", "SETTINGS.JSON"]),
			/duplicate/u,
		);
		assert.throws(
			() => normalizeSyncInclude(["../secrets"]),
			/safe agent-relative path/u,
		);
		assert.throws(
			() => normalizeSyncInclude(["custom", "custom/file.md"]),
			/overlapping/u,
		);
		assert.throws(
			() => normalizeSyncInclude(["pi-sync.json"]),
			/cannot be synced/u,
		);
		assert.deepEqual(normalizeSyncInclude([]), []);
	});
});

test("version 3 rejects recognized version 1/2 fields without rejecting unknown future fields", () => {
	for (const mutate of [
		(value: ReturnType<typeof settings>) =>
			Object.assign(value, { profiles: {} }),
		(value: ReturnType<typeof settings>) =>
			Object.assign(value.storageConnections.store, { accessKeyId: "legacy" }),
		(value: ReturnType<typeof settings>) =>
			Object.assign(value.syncSetups.home, { syncFiles: ["settings.json"] }),
		(value: ReturnType<typeof settings>) =>
			Object.assign(value.syncSetups.home.storage, { namespace: "legacy" }),
	]) {
		const value = settings();
		mutate(value);
		assert.throws(
			() => effectiveValidated(value),
			/unsupported version 1\/2 field/u,
		);
	}
	const future = settings() as ReturnType<typeof settings> & {
		futureTop?: unknown;
	};
	future.futureTop = { retained: true };
	assert.equal(effectiveValidated(future), future);
});

test("every documented connection and setup field is required", () => {
	const mutateRemote = (value: Record<string, unknown>) => delete value.remote;
	const val = settings();
	mutateRemote(val.storageConnections.store as Record<string, unknown>);
	assert.throws(
		() => effectiveValidated(val),
		/required|must be/u,
		"git missing remote",
	);

	for (const mutate of [
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home as Partial<ReturnType<typeof setup>>)
				.storage,
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home as Partial<ReturnType<typeof setup>>).sync,
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home.storage as { path?: string }).path,
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home.storage as { branch?: string }).branch,
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home.sync as { include?: string[] }).include,
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home.sync as { automatic?: boolean }).automatic,
	]) {
		const value = settings();
		mutate(value);
		assert.throws(
			() => effectiveValidated(value),
			/must be|missing|safe relative path/u,
		);
	}
});

test("credentials and own-property references fail closed", () => {
	const secretGit = settings();
	secretGit.storageConnections.store.remote =
		"https://user:secret@example.com/repo.git";
	assert.throws(
		() => effectiveValidated(secretGit),
		/userinfo are not allowed/u,
	);

	const badActive = settings();
	badActive.activeSyncSetup = "constructor";
	assert.throws(() => effectiveValidated(badActive), /activeSyncSetup/u);
});

function effectiveValidated(value: ReturnType<typeof settings>) {
	return validateSettingsDocument(value as unknown as Record<string, unknown>);
}

test("remote identity uses normalized reviewed coordinates and not the setup name", () => {
	const document = settings();
	const first = effectiveSyncSetupRemoteIdentity(
		document.syncSetups.home,
		document.storageConnections.store,
	);
	const renamed = effectiveSyncSetupRemoteIdentity(
		document.syncSetups.home,
		document.storageConnections.store,
	);
	assert.equal(first, renamed);
	const equivalent = setup();
	equivalent.storage.path = "/pi-sync/home/";
	assert.equal(
		first,
		effectiveSyncSetupRemoteIdentity(
			equivalent,
			document.storageConnections.store,
		),
	);
});

test("unsupported and invalid settings remain byte-for-byte unchanged and errors redact secrets", async () => {
	for (const value of [
		{ version: 1, accessKeyId: "do-not-show" },
		{ version: 2, secretAccessKey: "do-not-show" },
		{ profiles: {}, targets: {}, password: "do-not-show" },
	] as const) {
		await withTempHome(async (agentDir) => {
			await writeSettings(agentDir, value);
			const file = path.join(agentDir, "pi-sync.json");
			const before = await readFile(file);
			await assert.rejects(loadConfig(), (error: unknown) => {
				assert.match(String(error), /unsupported.*version 3/iu);
				assert.doesNotMatch(String(error), /do-not-show/u);
				return true;
			});
			assert.deepEqual(await readFile(file), before);
		});
	}
});
