import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CommandArgumentCompletion, CommandOptions } from "./types.js";

export const SYNC_COMMANDS = [
	{
		name: "setup",
		description: "Select content and review the Git destination",
	},
	{ name: "status", description: "Fetch and compare without applying changes" },
] as const;

export type SyncCommandName = (typeof SYNC_COMMANDS)[number]["name"];

/** Retained for internal legacy UI callers; public completion has no setup catalog. */
export function setSyncSetupCompletions(_names: readonly string[]) {}

export function splitArgs(input: string) {
	return (
		input
			.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
			?.map((arg) => arg.replace(/^['"]|['"]$/g, "")) ?? []
	);
}

export function parseOptions(args: string[]): CommandOptions {
	const values: string[] = [];
	let yes = false;
	let force = false;
	let stale = false;
	let setup: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--yes" || arg === "-y") yes = true;
		else if (arg === "--force") force = true;
		else if (arg === "--stale") stale = true;
		else if (arg === "--setup") {
			const name = args[index + 1];
			if (!name || name.startsWith("-"))
				throw new Error("--setup requires a sync setup name.");
			if (setup !== undefined)
				throw new Error("--setup may be provided only once.");
			setup = name;
			index += 1;
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown sync option: ${arg}`);
		} else values.push(arg);
	}
	return {
		yes,
		force,
		stale,
		silent: false,
		reload: true,
		auto: false,
		...(setup === undefined ? {} : { setup }),
		args: values,
	};
}

export function completeSyncArguments(
	argumentPrefix: string,
): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	const matches = SYNC_COMMANDS.filter(({ name }) => name.startsWith(prefix));
	return matches.length
		? matches.map(({ name, description }) => ({
				value: name,
				label: name,
				description,
			}))
		: null;
}

export function syncMenuOptions() {
	return SYNC_COMMANDS.map(
		({ name, description }) => `${name} — ${description}`,
	);
}

export function syncCommandFromMenuOption(
	option: string,
): SyncCommandName | undefined {
	return SYNC_COMMANDS.find(
		({ name, description }) => option === `${name} — ${description}`,
	)?.name;
}

export async function resolveSyncCommand(
	input: string,
	_ctx: ExtensionCommandContext,
) {
	const [subcommand = "sync", ...rest] = splitArgs(input);
	return { subcommand, rest };
}

export function usage() {
	return "Usage: /sync setup · /sync · /sync status\nSelect content and review one Git destination; sync safely; or fetch status without applying changes.";
}
