import type { SyncBackend } from "./sync-backend.js";
import type { AnySyncConfig } from "./types.js";

export type SyncBackendFactory = {
	bivarianceHack(config: AnySyncConfig): SyncBackend | Promise<SyncBackend>;
}["bivarianceHack"];

export const createSyncBackend: SyncBackendFactory = async (config) => {
	switch (config.backend.type) {
		case "s3": {
			const { S3SyncBackend } = await import("./s3-backend.js");
			return new S3SyncBackend(config.backend);
		}
		case "webdav": {
			const { WebDavSyncBackend } = await import("./webdav-backend.js");
			return new WebDavSyncBackend(config.backend);
		}
		case "git": {
			const { GitSyncBackend } = await import("./git-backend.js");
			return new GitSyncBackend(config.backend);
		}
	}
};
