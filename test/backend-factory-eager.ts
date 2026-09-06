import { GitSyncBackend } from "../src/git-backend.js";
import type { SyncBackend } from "../src/sync-backend.js";
import type { AnySyncConfig } from "../src/types.js";

export function createSyncBackend(config: AnySyncConfig): SyncBackend {
	if (config.backend.type !== "git") {
		throw new Error(
			`Unsupported backend type: ${config.backend.type}. Only Git is supported.`,
		);
	}
	return new GitSyncBackend(config.backend);
}
