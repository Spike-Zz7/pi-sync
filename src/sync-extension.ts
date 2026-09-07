import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSyncArguments, usage } from "./command.js";
import { withLock } from "./lock.js";
import { errorMessage } from "./manager-helpers.js";
import { loadSingleTargetSetup } from "./single-target.js";
import { recoverPendingSnapshotTransactions } from "./snapshot-transaction.js";
import { withStateDirectoryAccess } from "./state-directory.js";
import type { CommandOptions } from "./types.js";

/** Legacy injection seams remain available to internal consumers. */
export interface SyncDependencies {
	loadSetupSwitch(): Promise<unknown>;
	loadSnapshot(): Promise<
		Pick<typeof import("./snapshot.js"), "createSnapshot">
	>;
	loadSyncState(): Promise<
		Pick<typeof import("./sync-state.js"), "hasLocalChanges">
	>;
	loadSyncOperations(): Promise<typeof import("./sync-operations.js")>;
}

export default function sync(
	pi: ExtensionAPI,
	dependencies: Partial<SyncDependencies> = {},
) {
	let sessionAbort = new AbortController();
	let operations: Promise<typeof import("./sync-operations.js")> | undefined;
	const loadOperations = () => {
		operations ??= (
			dependencies.loadSyncOperations?.() ?? import("./sync-operations.js")
		).catch((error) => {
			operations = undefined;
			throw error;
		});
		return operations;
	};
	pi.on("session_start", () => {
		sessionAbort.abort(new DOMException("Session replaced", "AbortError"));
		sessionAbort = new AbortController();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		sessionAbort.abort(new DOMException("Session shut down", "AbortError"));
		ctx.ui.setStatus("sync", undefined);
	});
	pi.registerCommand("sync", {
		description: "Sync selected content through Git; setup or status",
		getArgumentCompletions: completeSyncArguments,
		handler: async (args, ctx) => {
			if (!ctx.hasUI)
				throw new Error(
					"/sync requires TUI or RPC mode so results are observable.",
				);
			const route = args.trim();
			if (route !== "" && route !== "setup" && route !== "status") {
				ctx.ui.notify(usage(), "warning");
				return;
			}
			const sessionSignal = sessionAbort.signal;
			try {
				if (route === "setup") {
					const { prepareSyncSetup } = await import("./sync-setup.js");
					sessionSignal.throwIfAborted();
					if (!(await prepareSyncSetup(ctx, sessionSignal))) return;
				}
				await withStateDirectoryAccess(async () => {
					if (route === "setup") {
						const { showSyncSetup } = await import("./sync-setup.js");
						sessionSignal.throwIfAborted();
						await showSyncSetup(ctx, sessionSignal);
						return;
					}
					const setup = await loadSingleTargetSetup();
					const module = await loadOperations();
					sessionSignal.throwIfAborted();
					const { runCancellableOperation } = await import(
						"./cancellable-operation.js"
					);
					await runCancellableOperation(
						ctx,
						route === "status"
							? "Checking sync status"
							: "Syncing selected content",
						route,
						async (_route, signal, onCommit) => {
							const options: CommandOptions = {
								yes: true,
								force: false,
								stale: false,
								silent: false,
								reload: false,
								auto: false,
								args: [],
								setup,
								signal,
								onCommit,
							};
							await withLock(route || "sync", async () => {
								signal?.throwIfAborted();
								if (setup !== (await loadSingleTargetSetup()))
									throw new Error("Sync destination changed. Run /sync again.");
								if (route === "status") await module.status(ctx, options);
								else {
									await recoverPendingSnapshotTransactions();
									signal?.throwIfAborted();
									await module.syncBoth(ctx, options);
								}
							});
							return { kind: "completed" };
						},
						{ signal: sessionSignal, commitAware: route === "" },
					);
				});
			} catch (error) {
				if (!sessionSignal.aborted) ctx.ui.notify(errorMessage(error), "error");
			} finally {
				if (!sessionSignal.aborted) ctx.ui.setStatus("sync", undefined);
			}
		},
	});
}
