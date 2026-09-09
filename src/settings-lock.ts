import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { agentDir } from "./config.js";
import { withLocalConfigFileLock } from "./config-file.js";

const held = new AsyncLocalStorage<boolean>();
let queue: Promise<unknown> = Promise.resolve();
/** Same settings.json.lock used by Pi's FileSettingsStorage; queue before awaits. */
export function withSyncSettingsLocks<T>(run: () => Promise<T>): Promise<T> {
	if (held.getStore()) return run();
	const result = queue.then(() =>
		withLocalConfigFileLock(async () => {
			await fs.mkdir(agentDir(), { recursive: true });
			const release = await lockfile.lock(
				path.join(agentDir(), "settings.json"),
				{
					realpath: false,
					retries: { retries: 100, minTimeout: 10, maxTimeout: 100 },
				},
			);
			try {
				return await held.run(true, run);
			} finally {
				await release();
			}
		}),
	);
	queue = result.catch(() => undefined);
	return result;
}
