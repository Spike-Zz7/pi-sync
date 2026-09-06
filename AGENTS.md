# Pi Sync Guidelines

## Settings and migration

- Hold one cross-process lock across each settings read-modify-write, full validation, and atomic same-directory replacement.
- Queue the complete mutation before prerequisite awaits so rapid commands retain invocation order.
- Make every writer share the lock protocol and recheck file absence immediately before rename.
- Do not treat an absent operation lock as proof that no idle older process exists during state-directory migration.
- Require explicit migration confirmation, serialize upgraded state and cache users against the guard, keep legacy state active until migration, and fail closed when old and new roots coexist.

## Backends and snapshots

- Keep snapshot content IDs, backend snapshot references, and backend-scoped opaque revisions distinct.
- Make `--force` reread and republish against the observed revision rather than disabling concurrency checks.
- Preserve temporary-credential support for Cloudflare R2, but retry once without `X-Amz-Security-Token` when static keys reject that header.
- When pull replaces a file ancestor with a directory, defer descendant preflight until ancestor deletion and journal `ENOTDIR` descendants as missing so rollback restores the file.

## Git subprocesses

- Close stdin, strip inherited Git control variables, and disable prompts, hooks, pagers, and editors in non-interactive Git subprocesses.
- Serialize shared-cache mutations and reconcile remote refs after ambiguous transport failures.

## Interaction model

- Collect credentials in a masked TUI and review one exact backend path during setup.
- Expose storage connections and sync setups as the only managed user concepts.
