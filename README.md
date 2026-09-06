# 🔄 pi-sync — Sync Pi Settings Through Git

[![npm](https://img.shields.io/npm/v/@narumitw/pi-sync)](https://www.npmjs.com/package/@narumitw/pi-sync) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Sync synchronizes selected Pi settings and content across machines through a private Git repository. Reusable storage connections identify repositories, while named sync setups define the branch, repository path, included content, and automatic-sync policy.

## ✨ Features

- Manages Git storage connections and named sync setups through `/sync`.
- Uses existing non-interactive SSH or Git credential-helper authentication and never stores Git credentials.
- Protects changes with immutable snapshots, secret scanning, locks, expected-ref leases, pull backups, transactional apply, and recovery journals.
- Keeps snapshot selection portable and free of credentials.
- Writes settings atomically, preserves unknown fields, rejects stale edits, and fails closed on unsafe configuration.
- Loads a generated split runtime with lazy UI and backend chunks.

## 📦 Install

```bash
pi install npm:@narumitw/pi-sync
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-sync
```

Build and try a local checkout:

```bash
npm install
npm run build
pi -e .
```

The package declares `dist/index.ts`, so an unbuilt checkout must run the build before Pi loads it. Extensions run with Pi's permissions; install only packages from sources you trust.

## 🚀 Quick start

1. Create an empty private Git repository, or reserve a new branch in an existing private repository.
2. Configure non-interactive SSH or a Git credential helper outside Pi Sync.
3. Run `/sync` and choose **Set up sync**.
4. Enter a setup name and the credential-free SSH or HTTPS remote URL.
5. Review the exact branch, repository path, included content, and automatic-sync policy before saving.

New setups default to branch `main` and repository path `./`. Pi Sync owns the entire selected branch, so do not select a branch containing unrelated files. At `./`, it stores `manifest.json` and `files/` at the repository root. It operates through a private bare cache and never modifies your local working tree.

Two configured setups cannot use the same normalized repository and branch. A different path on the same branch is not sufficient because publication replaces the branch snapshot.

## 🧭 Manager, conflicts, and recovery

The `/sync` manager shows local state without contacting the remote:

```text
Current sync setup: home
Storage: Git · origin · main:./
Included: 4 categories (7 paths) · Sessions: Off
Automatic sync: On
Remote status: Not checked
```

Primary actions include **Sync now**, **Switch sync setup**, **Status & changes**, **Settings**, and **More…**.

When local and remote content diverge, Pi Sync requires a reviewed direction:

- **Keep local content and replace remote…** performs a forced push while retaining expected-ref concurrency protection.
- **Use remote content and replace local…** creates a local backup and transactionally applies the selected remote snapshot.
- Included-content policy mismatches must be reviewed separately before syncing.
- Cancellation leaves settings, local files, remote data, and sync state unchanged.

Automatic startup sync never silently resolves a conflict. TUI mode exposes review actions and an in-memory attention indicator; RPC review remains read-only. Print and JSON modes do not support `/sync` because UI output is not observable there.

### Restore sync access

An active operation guard prevents lock removal while another Pi Sync process may still be starting or finishing. If a stopped operation leaves a stale local lock, close every Pi process that might be syncing and use the guarded **Restore sync access…** flow. `/sync unlock --stale` provides the command equivalent. Recovery rechecks ownership before removal and never changes settings, managed files, sync state, or remote data.

## ⚙️ Settings

The canonical private settings file is `<getAgentDir()>/pi-sync.json`, normally `~/.pi/agent/pi-sync.json`. Missing settings remain unconfigured without creating files or locks.

A minimal setup is:

```json
{
  "version": 3,
  "activeSyncSetup": "home",
  "onSwitch": "ask-before-pull",
  "skipSecretScan": false,
  "storageConnections": {
    "origin": {
      "type": "git",
      "remote": "git@github.com:owner/private-pi-sync.git"
    }
  },
  "syncSetups": {
    "home": {
      "storage": {
        "connection": "origin",
        "branch": "main",
        "path": "./"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md"],
        "automatic": false
      }
    }
  }
}
```

Settings writes are atomic and private (`0600` on POSIX), preserve unknown fields, and coordinate across Pi Sync processes. Malformed, invalid, unsupported, symlinked, or concurrently changed documents remain untouched. Version 1, version 2, and non-empty unversioned settings require manual recovery rather than automatic migration.

Adding `sessions` can upload prompts, tool output, paths, images, and secrets; interactive flows require a privacy acknowledgement. **Settings → Skip secret scan** defaults to **Off** and applies globally. Enable it only after reviewing the selected content and private destination.

Read the [settings reference](./docs/settings.md) for the complete schema, included-content rules, Git restrictions, and recovery steps.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/sync` | Set up Git storage, manage synced content, and review operations or recovery. |
| `/sync help` | Show command usage. |
| `/sync use <setup>` | Switch the active setup according to its switch policy. |
| `/sync init` | Create a local configuration template. |
| `/sync config` | Show resolved configuration. |
| `/sync files` | List included local files. |
| `/sync status` | Compare local and remote snapshot state. |
| `/sync diff` | Show local and remote differences. |
| `/sync doctor` | Check configuration, connectivity, Git safety, and possible secrets. |
| `/sync push` | Publish local content to the selected Git branch. |
| `/sync pull` | Back up local content, then apply the remote snapshot. |
| `/sync sync` | Choose a safe direction or require conflict review. |
| `/sync history` | Browse remote snapshots and review a rollback. |
| `/sync rollback <snapshot-id>` | Apply and republish a historical snapshot. |
| `/sync migrate-state` | Migrate the legacy local state directory. |
| `/sync unlock --stale` | Recover an abandoned local lock after ownership checks. |

Useful flags:

- `--setup <name>` targets a setup without switching it.
- `--yes` (`-y`) skips operation confirmation after you have independently reviewed the effects.
- `--force` accepts content conflicts but does not disable expected-ref concurrency checks.
- `--stale` is required by `unlock`.

## 🔄 Git and recovery model

Git publication uses an exact expected-ref lease. `--force` rereads the observed revision and republishes against it rather than bypassing concurrency protection. Ambiguous transport failures are followed by remote-ref reconciliation.

Git 2.30 or newer and a SHA-1-format remote repository are required. HTTPS userinfo, URL passwords, local paths, `file`, `git`, `ext`, and remote-helper transports are rejected. The private bare cache under `<agent-dir>/pi-sync/git/` is rebuildable.

Before pull or rollback, Pi Sync writes a backup under `<agent-dir>/pi-sync/backups/`. Apply preflights paths and checksums, journals mutations, restores prior state after failures, and recovers interrupted journals on startup. Removing a local setup or connection never deletes remote data.

The operational state root is `<agent-dir>/pi-sync/`. Existing installations using `<agent-dir>/.pisync/` remain on that root until an explicitly confirmed `/sync migrate-state`. If old and new roots coexist, or either root is a symlink or non-directory, Pi Sync refuses stateful work rather than merging or deleting data.

## 🔒 Security and privacy

- Settings and operational state paths are permanently excluded from snapshots.
- Push scans managed local content for common secret patterns unless **Skip secret scan** is enabled; `/sync doctor` always scans.
- Snapshot references, checksums, paths, manifests, response sizes, and Git revisions are validated.
- Symlink parents, path escapes, duplicate paths, and unsafe file/directory replacement fail before local mutation.
- Git subprocesses close stdin and disable prompts, hooks, pagers, and editors.
- Cancellation aborts preparation and dialogs; commit boundaries finish with bounded signals and report ambiguous outcomes explicitly.
- Terminal-bound names, paths, metadata, and errors are control-character sanitized.

## 🗂️ Package layout

```text
pi-sync/
├── src/                     # Git backend, settings, snapshots, UI, and recovery
├── dist/                    # Generated Pi runtime
├── scripts/build-runtime.mjs
├── docs/
└── test/
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 📄 License

[MIT](./LICENSE)
