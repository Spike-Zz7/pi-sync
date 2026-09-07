import { readLocalConfigObject } from "./config.js";
import type { PiSyncSettingsV3 } from "./types.js";

/** Legacy catalogs stay intact; ambiguity requires an explicit setup review. */
export function singleTargetSetup(settings: PiSyncSettingsV3 | undefined) {
	const names = Object.keys(settings?.syncSetups ?? {});
	if (names.length === 0)
		throw new Error("Sync is not configured. Run /sync setup.");
	if (names.length === 1) return names[0];
	if (
		typeof settings?.singleTargetSetup === "string" &&
		settings.singleTargetSetup === settings.activeSyncSetup &&
		names.includes(settings.singleTargetSetup)
	)
		return settings.singleTargetSetup;
	throw new Error(
		"Multiple legacy sync setups exist. Run /sync setup to explicitly review one target; other setups will be preserved.",
	);
}

export async function loadSingleTargetSetup() {
	return singleTargetSetup(await readLocalConfigObject());
}
