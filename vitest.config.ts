import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^.*\/test\/support(\.js)?$/,
				replacement: path.resolve(__dirname, "test/support.ts"),
			},
		],
	},
	test: {
		server: {
			deps: {
				external: ["@earendil-works/pi-coding-agent"],
			},
		},
	},
});
