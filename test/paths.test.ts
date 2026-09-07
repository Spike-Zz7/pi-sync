import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { isDeniedPath, sessionStorageRoot, toPosix } from "../src/paths.js";

test("toPosix normalizes backslashes to forward slashes across all platforms", () => {
	assert.equal(toPosix("dir\\subdir\\file.txt"), "dir/subdir/file.txt");
	assert.equal(isDeniedPath("dir\\.git\\config"), true);
	assert.equal(isDeniedPath("dir\\node_modules\\pkg"), true);
});

test("sessionStorageRoot expands home without a HOME environment variable", () => {
	const previous = process.env.HOME;
	delete process.env.HOME;
	try {
		assert.equal(sessionStorageRoot("/unused", "~"), path.resolve(homedir()));
		assert.equal(
			sessionStorageRoot("/unused", "~/sessions"),
			path.resolve(homedir(), "sessions"),
		);
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	}
});
