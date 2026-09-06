import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { sessionStorageRoot } from "../src/paths.js";

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
