# Strict managed environment

Strict sync means the same **active, selected agent-global environment**, not identical disks, operating systems, project settings, CLI resources, credentials, external executables, or currently running extension instances. Reload/restart Pi after a successful content change to activate the restored resources.

## Shared policy and compatibility

New publications use snapshot version 2 and Git manifest version 3. The versioned `selection` is authoritative for this repository + branch + path. Binding reads the immutable snapshot and adopts its selection; an empty receiving device no longer has to guess which boxes to select. First sync against a strict target adopts that target's selected content, replacing conflicting selected defaults with a recoverable backup. Local automatic-sync preferences are not shared.

A policy edit is a sync change even when file bytes are equal. Concurrent policy/content changes still require reconciliation; Git publication always uses its observed revision lease. If the remote changes during bind/pull review, retry. Older clients reject the new wire version instead of applying a partial environment.

Legacy snapshots remain readable with their prior local-selection behavior. They have no strict package guarantee until upgraded by a new publication. Never-managed legacy remote files can remain stored outside the shared selection, but are not activated by strict pull. `sync-environment.json` and `sync-packages/` are reserved wire payloads, not loose resources in the receiving agent directory.

Deleting selected files propagates. Withdrawing a previously managed path from shared policy removes **only exact previously recorded paths** from the active environment, not entire withdrawn directories or never-managed siblings. Modified withdrawn files stop sync; their ownership is not permission to erase arbitrary replacements. Old generations and local source checkouts remain available for recovery and are not garbage-collected.

## Skills and packages

- Custom `skills/` directories include `SKILL.md`, scripts, references and assets. Executable file bits are retained. A symlinked skill root is copied as ordinary files; nested links must remain inside that resolved root, and cycles/escapes fail closed.
- npm packages are pinned to the actually installed package version. A source npm v2/v3 lockfile and manifest are transported for `npm ci --omit=dev`; locked runtime dependency versions and integrity-bearing HTTPS sources are required. Dev-only lock entries are not treated as runtime requirements. Packages still load through Pi's documented local-package settings semantics after restoration; package-owned skills are not separately discovered/copied into the loose skills directory.
- Git packages are pinned to the installed full commit. Modified tracked source is rejected. Runtime dependencies need a portable npm lockfile. Existing non-interactive SSH/Git authentication is used.
- Local-path package directories are bundled, without `node_modules`, `.git`, credentials or operational state. The source machine's paths are not published. Local single-file extensions are supported only as standalone files; use a directory package for imports/assets/dependencies.
- Explicit global resource paths in `settings.skills`, `extensions`, `prompts`, and `themes` are bundled and rewritten to managed relative paths. References already inside selected roots stay in place, avoiding a second loose copy. Resource globs/filters are not yet portable and fail with an actionable error rather than publishing unusable source-machine paths. Package object-form resource filters are retained.

Canonical source/version metadata and bundle content remain separate from generated settings paths. A receiver can publish again without converting packages into machine-specific paths or creating endless settings differences.

## Required installs, trust and recovery

**Syncing a reviewed target authorizes mandatory package installation, including normal lifecycle hooks. Hooks and restored extensions run with your user permissions. Staging is not a sandbox.** Only bind a private target whose writers and packages you trust. Hooks can affect files outside their working directory; Pi Sync cannot roll back arbitrary hook side effects.

Installations happen in an unreferenced generation under `pi-sync/environments/`. The installer command is controlled locally, never by snapshot `npmCommand` wrappers. Subprocesses close stdin, disable interactive Git prompts/hooks/editors, bound output/runtime, and terminate their process group on cancellation. Existing machine credentials are used but never transferred in package bundles.

Package identities, locked dependencies and declared resource paths are checked before activation. An installation/verification failure does not commit content, settings or an applied baseline; fix registry/authentication/lockfile problems and run `/sync` again. Missing or damaged installed generations are replaced with a fresh generation rather than overwriting a potentially live generation. Files/settings/policy share rollback journals and settings locks; apply failure restores previous settings/content. Successfully staged generations survive an apply failure and can be reused on retry.

No applied success is reported for a partial local restoration. If publication succeeded but local activation/state persistence failed, the error explicitly identifies a remote publication that is already active; do not assume the remote was rolled back.

## Limits that fail closed or remain outside the guarantee

Local-link/workspace or non-integrity-bearing runtime dependency locks need conversion to portable locked dependencies. npm registry/platform availability and native builds can still fail. Package hooks are arbitrary code, so verification cannot prove that every possible skill command or external tool will work. No blanket `node_modules` copying or OS-tool installation is attempted.

Explicit resource globs/exclusions and package resources whose manifest escapes the package root are unsupported. Nested symlink escape targets are not silently swept into snapshots. Source packages requiring excluded credential/state files must be made portable. Global resources outside the selected agent root and explicit settings paths (for example project/CLI additions) are not automatically swept from the filesystem. On Windows, npm subprocess execution resolves trusted `npm-cli.js` beside Node.js or in PATH and executes via `process.execPath` with `shell: false`, avoiding `cmd.exe` shell injection and Node.js batch-file spawn restrictions (`spawn EINVAL`); if `npm-cli.js` cannot be resolved on Windows, package installation fails closed explicitly. Cross-platform native packages require platform validation; current integration tests use isolated Linux fixtures and fake installers, not a live npm registry.
