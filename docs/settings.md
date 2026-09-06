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
        "automatic": true
      }
    },
    "work": {
      "storage": {
        "connection": "origin",
        "branch": "pi-sync/work",
        "path": "pi-sync/work"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md"],
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

A referenced connection cannot be removed. The current setup must be switched before removal. `activeSyncSetup` must reference an own-property setup when setups exist and must be absent when the setup catalog is empty.

Every setup requires `sync.include` and explicit `sync.automatic`.

`onSwitch` accepts:

- `ask-before-pull` — switch, then ask in TUI whether to start a reviewed pull;
- `pull-after-switch` — require observable UI and start the normal reviewed pull;
- `switch-only` — switch without reading or applying remote content.

## Secret scanning

The global `skipSecretScan` setting accepts a boolean and defaults to `false`, including when omitted from an existing version 3 document.

Set it through **/sync → Settings → Skip secret scan**. Changes apply to subsequent pushes for every setup, including automatic pushes. When enabled, pushes skip the local secret scan; other safety checks and confirmations remain unchanged. `/sync doctor` still scans and reports possible secrets regardless of this setting.

## Included content

`sync.include` is ordered and duplicate-free. Primary recommended categories and paths are:

- **Preferences**: `settings.json`, `keybindings.json`
- **Instructions & prompts**: `AGENTS.md`, `APPEND_SYSTEM.md`, `prompts`
- **Skills**: `skills`
- **Usage records**: `token-usage.jsonl`

New setups recommend and default to these 7 exact paths. Additional optional paths (`models.json`, `lsp.json`, `themes`, `extensions`, `sessions`) and safe agent-relative custom files or directories may also be included through the custom content flow. Absolute paths, `..`, backslashes, control characters, denied settings/state paths, duplicate case variants, and ambiguous nested paths under reserved roots are rejected.

An empty array is valid but represents no useful transfer. Unselected content remains unmanaged locally and is preserved when republishing an existing remote snapshot.

The Included Content editor holds an in-memory draft. Leaving it opens an exact Include/Exclude review; only **Save changes** writes settings. RPC exposes a read-only summary.

Every new snapshot stores the normalized content selection separately from files that happened to exist. Automatic sync and pull pause when the remote content policy differs rather than silently expanding local scope. Adoption revalidates the Git ref, snapshot, setup coordinates, and local selection before atomically changing only `sync.include`.

Older snapshots without an authoritative selection remain readable, but Pi Sync can only infer a partial list from safe remote file roots.

Adding `sessions` requires a privacy acknowledgement in interactive flows. Session JSONL can contain prompts, tool output, file paths, images, and secrets. Automatic apply protects the currently open session file; restart Pi or resume a pulled session to use synchronized conversations.

## Unsupported old settings and recovery

Only Git storage connections are supported. Documents containing another connection type fail validation with an explicit Git-only error and remain untouched.

Version 1, version 2, and non-empty unversioned documents are unsupported after the version 3 schema reset. Pi Sync does not migrate, partially interpret, downgrade, or overwrite them. Automatic sync pauses and reports an actionable version 3 error without displaying secrets.

Recovery:

1. retain the old file byte-for-byte;
2. move it aside manually;
3. create a new Git-only version 3 document or run the setup manager;
4. run `/sync doctor`, inspect the exact repository, branch, and path, then review the first pull or push;
5. restore the retained file and a compatible older package only if rolling back.

Malformed, invalid, unsupported, symlinked, or concurrently changed documents remain untouched. Failed UI saves keep the previous file and displayed/effective state.
