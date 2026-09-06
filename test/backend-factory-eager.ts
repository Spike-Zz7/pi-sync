import { GitSyncBackend } from "../src/git-backend.js";
import { S3SyncBackend } from "../src/s3-backend.js";
import type { SyncBackend } from "../src/sync-backend.js";
import type { AnySyncConfig } from "../src/types.js";
import { WebDavSyncBackend } from "../src/webdav-backend.js";

export function createSyncBackend(config: AnySyncConfig): SyncBackend {
	switch (config.backend.type) {
		case "s3":
			return new S3SyncBackend(config.backend);
		case "webdav":
			return new WebDavSyncBackend(config.backend);
		case "git":
			return new GitSyncBackend(config.backend);
	}
}
