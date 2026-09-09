# 🔄 pi-sync — Sync selected Pi content through Git

Pi Sync keeps selected files and directories in sync with **one private Git destination**, using your existing non-interactive SSH or Git credential-helper authentication. It never stores Git credentials.

## Install

```bash
pi install npm:@narumitw/pi-sync
```

For a local checkout, run `npm install && npm run build`, then `pi -e .`. The package loads the generated, split runtime in `dist/`.

## Three commands

| Command | What it does |
| --- | --- |
| `/sync setup` | Review one repository, branch and path; adopt its shared content policy when binding. No content is transferred. |
| `/sync` | Align shared files, skills and exact plugin versions, including required installation. |
| `/sync status` | Fetch current remote content and show **synced**, **local ahead**, **remote ahead**, or **diverged**, without applying content or updating the sync baseline. |

No manager, named-target switching, manual push/pull commands, or force-resolution flags are exposed. Startup and shutdown do not sync, even with legacy automatic-sync settings enabled. Setup requires TUI mode; sync and status work in TUI and RPC. Print/JSON modes are rejected because results would not be observable.

### Set up

1. Create a private Git repository and configure SSH or a Git credential helper outside Pi.
2. Run `/sync setup`. Select agent-relative files or directories, including safe custom paths that may exist only remotely.
3. Enter and review the exact repository, branch (default `main`), and repository path (default `./`). Blank input keeps the displayed current/default value.
4. Save, then run `/sync status` or `/sync`.

**Pi Sync owns the entire selected branch.** Choose a dedicated branch without unrelated files. At `./`, Pi Sync stores `manifest.json` and `files/` at the repository root. It uses a private bare cache, never your repository working tree. Publication automatically creates a Git commit and pushes with an exact expected-ref lease.

### Direction and deletions

Direction is based on selected **file content**, not Git commit counts:

- Equal content: no content changes (sync may initialize/refresh its baseline).
- Only local content changed: automatically commit and push.
- Only remote content changed: back up local content and transactionally pull.
- Both sides changed differently: stop without overwriting either side. Reconcile the selected content independently, then retry. There is no force shortcut.

Deleting a selected file propagates, including the last file in a directory. **New strict targets share one versioned selection policy.** Withdrawing previously managed files removes their exact recorded paths with backup/rollback; never-managed siblings and source package checkouts remain untouched. Policy edits participate in conflict detection.

On first sync against a strict target, the receiving device adopts the target's selected files and required package environment, backing up replaced defaults. Legacy targets still stop on different nonempty sides without a common baseline. A previously synced branch disappearing is not an authoritative empty snapshot and stops safely.

### Required skill and plugin restoration

Custom skills include their full directories and assets; safe skill-root symlinks are materialized. npm/Git plugins are restored at installed exact versions/commits, with locked runtime dependencies. Local-path plugins and explicit external resource paths are bundled into portable managed storage. Package-provided skills stay with their package rather than becoming duplicate loose copies. Installation or verification failure is an incomplete sync, not success; retry with `/sync` after fixing the reported problem.

**Binding a trusted target authorizes mandatory installation and package lifecycle hooks. Hooks run with your user permissions; staging is not a sandbox and arbitrary hook side effects cannot be rolled back.** No per-package optional-install toggle is used.

The guarantee is the **active selected agent-global environment**, not the OS, credentials, project/CLI resources or every file on disk. Reload/restart Pi to activate restored extensions. New snapshots use wire v2/Git manifest v3; older clients fail closed. Legacy snapshots remain readable without a strict environment guarantee until upgraded. See [strict environment behavior, recovery and limitations](docs/strict-environment.md).

### Privacy and safety

- `auth.json`, private settings, operational state, credentials, and unsafe paths are excluded.
- Selected sessions can contain prompts, tool output, paths, images, and secrets; setup requires a privacy acknowledgement. The currently open session file is protected from pull and excluded from direction checks; restart/resume to use pulled conversations.
- Push scans for common secret patterns unless the existing private `skipSecretScan` setting is explicitly enabled.
- Locks serialize operations and cache writes. Git publication uses compare-and-swap, including reconciliation after ambiguous transport failures.
- Pull writes backups and uses validated paths, preflight checks, rollback journals, and interrupted-transaction recovery. Recovery happens on explicit `/sync`, not status.
- Status can update the private Git cache and acquire locks, but does not apply selected files, publish commits, or update the sync baseline.
- Cancellation stops preparation. Once apply/publication starts, the bounded commit boundary finishes safely.

## Existing installations and recovery

Private settings remain at `<getAgentDir()>/pi-sync.json` (normally `~/.pi/agent/pi-sync.json`). The version 3 storage-connection/setup schema is retained internally for compatibility; unknown fields and other existing setups are preserved.

One existing setup is reused. If several legacy setups exist, `/sync` and status refuse to choose silently. Run `/sync setup` to explicitly choose and review one target once; future commands use only that target. Other setups are not deleted. Changing a shared connection does not change the destinations of other setups.

Malformed, unsupported, unsafe, or concurrently changed settings remain untouched. Version 1, version 2, and nonempty unversioned settings require manual recovery, not automatic conversion. See the [settings reference](docs/settings.md).

Operational state normally lives in `<agent-dir>/pi-sync/`. Legacy `.pisync/` remains active until an explicitly confirmed migration offered by `/sync setup`; close every other Pi process first. If both roots coexist, syncing fails closed rather than merging or deleting data.

If an abandoned operation lock blocks syncing, `/sync setup` offers guarded recovery only when needed. Confirm every other Pi process is closed; live owners and active guards cannot be bypassed. Do not manually delete locks while a process may be syncing.

Git 2.30+ and SHA-1 repositories are required. Credential-bearing HTTPS URLs and local, `file`, `git`, `ext`, or remote-helper transports are rejected. Extensions run with your user permissions; install only packages you trust.

## Development

```bash
npm test
npm run check
```

[MIT](LICENSE)
