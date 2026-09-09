# Pi Sync settings reference

[Back to README](../README.md)

- [Settings file](#settings-file)
- [Complete version 3 example](#complete-version-3-example)
- [Git connection and setup fields](#git-connection-and-setup-fields)
- [Secret scanning](#secret-scanning)
- [Included content](#included-content)
- [Unsupported old settings and recovery](#unsupported-old-settings-and-recovery)

## Settings file

The canonical private user file is:

```text
~/.pi/agent/pi-sync.json
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable. Missing settings load as unconfigured without creating an agent directory, file, temporary file, or lock.

An explicit setup creates the file atomically. On POSIX, Pi Sync creates and replaces it with mode `0600`. Processes coordinate settings access through `pi-sync.json.mutation-lock`; lock-unaware editors should not save the file while a Pi Sync settings operation is running.

A private `pi-sync.local.json` containing a valid version 3 document is copied byte-for-byte to `pi-sync.json`, while the old file remains as a recovery copy. If both paths exist, `pi-sync.json` wins and the legacy file remains untouched.

## Complete version 3 example

```json
{
  "version": 3,
  "activeSyncSetup": "home",
  "singleTargetSetup": "home",
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
        "include": ["settings.json", "AGENTS.md", "skills", "prompts", "themes"],
        "automatic": false
      }
    }
  }
}
```

## Git connection and setup fields

A storage connection requires:

- `type`: exactly `"git"`;
- `remote`: a credential-free SSH or HTTPS Git remote.

A setup's `storage` requires:

- `connection`: the name of an existing Git storage connection;
- `branch`: the exclusively managed remote branch;
- `path`: a non-empty repository-relative path, or `.` / `./` for the repository root.

Git authentication comes from existing non-interactive SSH configuration or a configured credential helper. Credentials must not be embedded in the remote URL and are never stored by Pi Sync.

New setups default to branch `main` and path `./`. The root forms `.` and `./` normalize to `./` and share one state and backend identity. Editing a setup defaults to its current path.

Pi Sync owns the entire selected branch. A branch containing unrelated files is rejected rather than overwritten. Two setups cannot resolve to the same normalized remote repository and branch, including through equivalent connection aliases. A different directory on the same branch does not isolate publication and is therefore not accepted as a separate setup destination.

The schema retains catalogs for compatibility, but only one target is exposed. A lone setup is reused. Multiple legacy setups require explicit review in `/sync setup`; it stores `singleTargetSetup` alongside `activeSyncSetup`. If these disagree, normal sync/status refuse to choose. Other setups and unknown fields are preserved.

Every setup still requires `sync.include` and explicit `sync.automatic`. `automatic` and `onSwitch` are legacy compatibility fields: this runtime does not perform lifecycle sync or expose setup switching. Only `/sync` transfers content.

## Secret scanning

The global `skipSecretScan` setting accepts a boolean and defaults to `false`, including when omitted from an existing version 3 document.

It is an advanced private-file setting, not a normal UI toggle. Enable it only after independently reviewing the selected content and destination; all concurrency and path safety checks remain enabled.

## Included content

`sync.include` is ordered and duplicate-free. Primary recommended categories and paths are:

- **Preferences**: `settings.json`, `keybindings.json`
- **Instructions & prompts**: `AGENTS.md`, `APPEND_SYSTEM.md`, `prompts`
- **Skills**: `skills`
- **Usage records**: `token-usage.jsonl`

New setups recommend and default to these 7 exact paths. Additional optional paths (`models.json`, `lsp.json`, `themes`, `extensions`, `sessions`) and safe agent-relative custom files or directories may also be included through the custom content flow. Absolute paths, `..`, backslashes, control characters, denied settings/state paths, duplicate case variants, and ambiguous nested paths under reserved roots are rejected.

An empty array is valid. New strict snapshots still publish a shared policy/environment manifest. Never-managed content outside the selection remains unmanaged.

`/sync setup` holds selection and destination edits in memory until the exact final review is confirmed. Cancelling does not save the draft or transfer content. RPC directs you to TUI for setup.

New wire-v2 snapshots make normalized selection authoritative for the reviewed repository, branch and path. Binding/pulling adopts it with revision and local-config checks. Policy changes sync even without file changes. Withdrawing previously managed paths removes only exact recorded files, with backup/rollback and conflict checks; never-managed siblings are preserved. Legacy wire-v1 snapshots retain local-selection compatibility. See [strict environment](strict-environment.md) for mandatory package installation and resource portability.

Older snapshots without an authoritative selection remain readable, but Pi Sync can only infer a partial list from safe remote file roots.

Adding `sessions` requires a privacy acknowledgement in interactive flows. Session JSONL can contain prompts, tool output, file paths, images, and secrets. Pull protects the currently open session file; restart Pi or resume a pulled session to use synchronized conversations.

## Unsupported old settings and recovery

Only Git storage connections are supported. Documents containing another connection type fail validation with an explicit Git-only error and remain untouched.

Version 1, version 2, and non-empty unversioned documents are unsupported after the version 3 schema reset. Pi Sync does not migrate, partially interpret, downgrade, or overwrite them. Explicit commands report a version 3 error without displaying secrets. Startup and shutdown do not sync.

Recovery:

1. retain the old file byte-for-byte;
2. move it aside manually;
3. create a new Git-only version 3 document or run `/sync setup`;
4. review the exact repository, branch, and path, then run `/sync status`; differing nonempty initial sides stop safely until independently reconciled;
5. restore the retained file and a compatible older package only if rolling back.

Malformed, invalid, unsupported, symlinked, or concurrently changed documents remain untouched. Failed UI saves keep the previous file and displayed/effective state.
