import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isCloudflareR2Endpoint } from "./config.js";

export async function requiredExistingBucket(
	ctx: ExtensionCommandContext,
	example: string,
	signal?: AbortSignal,
) {
	const value = await ctx.ui.input(
		`Existing bucket\n\nThe bucket must already exist; pi-sync will not create it.\nExample: ${safeTerminalText(example)}`,
		undefined,
		{ signal },
	);
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new DOMException("The operation was aborted", "AbortError");
	}
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) {
		ctx.ui.notify("Enter the name of an existing R2/S3 bucket, or cancel setup.", "warning");
		return undefined;
	}
	return normalized;
}

export async function requiredInput(
	ctx: ExtensionCommandContext,
	title: string,
	defaultValue: string,
	signal?: AbortSignal,
) {
	return withoutPlaceholder(await promptTextInput(ctx, title, { defaultValue }, signal));
}

export async function requiredValueInput(
	ctx: ExtensionCommandContext,
	title: string,
	example: string,
	signal?: AbortSignal,
) {
	return withoutPlaceholder(await promptTextInput(ctx, title, { example }, signal));
}

// Text collection does not impose backend-specific syntax; callers validate the returned value.
export async function promptTextInput(
	ctx: ExtensionCommandContext,
	title: string,
	options: { defaultValue?: string; example?: string },
	signal?: AbortSignal,
) {
	if (signal?.aborted) signal.throwIfAborted();
	// Pi's TUI ignores input placeholders. Keep guidance visible in the title in every UI mode.
	const hint =
		options.defaultValue !== undefined
			? `Default: ${safeTerminalText(options.defaultValue)} (leave blank to keep)`
			: `Example: ${safeTerminalText(options.example ?? "")}\nEnter your own value; this example is not a default.`;
	const value = await ctx.ui.input(`${title}\n\n${hint}`, undefined, { signal });
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new DOMException("The operation was aborted", "AbortError");
	}
	if (value === undefined) return undefined;
	const normalized = value.trim() || options.defaultValue;
	if (!normalized) {
		ctx.ui.notify(`${title.split("\n")[0]} is required.`, "warning");
		return undefined;
	}
	return normalized;
}

function withoutPlaceholder(value: string | undefined) {
	// Preserve the existing Git/S3 placeholder policy; WebDAV permits literal angle brackets.
	return value?.includes("<") || value?.includes(">") ? undefined : value;
}

export function storageDescription(
	kind: string | undefined,
	endpoint: string | undefined,
	bucket: string | undefined,
) {
	const label =
		kind === "r2" || isCloudflareR2Endpoint(endpoint) ? "Cloudflare R2" : "S3-compatible";
	return `${label} · ${safeTerminalText(bucket ?? "bucket missing")}`;
}

export function ownRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function safeTerminalText(value: string) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}

export function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
