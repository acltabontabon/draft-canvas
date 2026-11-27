# Canvas Evolution security

The threat model for diagram history. Everything history reads from outside the running editor is
untrusted: repositories on disk, bundles, fetched objects, commit metadata, collaboration messages and
requests over the desktop shell's IPC. See [Canvas Evolution](evolution.md) for the architecture.

## Assets and boundaries

| Asset | Where | Who may change it |
| --- | --- | --- |
| A diagram's history | Web: IndexedDB `draft-canvas-history`. Desktop: `<app data>/history/<repoId>.git` | The editor recording that working copy; the person's explicit actions |
| Working-copy bindings | Web: the same database. Desktop: `history/bindings.json` | The history service |
| The person's Git identity label | `localStorage` preferences | The person, in Settings → History |
| Credentials for remotes | The person's own credential helper or keychain | Never Draft Canvas |

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Malicious bundle: path traversal, odd trees, foreign files | Import runs into a new, unbound repository. Every revision any ref reaches must have a tree of exactly `100644 blob diagram.draftcanvas`, and its blob must pass `parseDocument`; otherwise the repository is removed whole. No tree path is ever written to a file system. |
| Decompression bombs, giant objects, deep delta chains | `packScan.ts` walks the pack before any library inflates it. Each object's stream is read to its exact end, where the indexer will end it too, and its output is counted against its declared size. Objects are capped at 24 MB, the total inflated at 2 GB, deltas at depth 4096, and the object count is bounded. A delta that names its base by id counts as one level deeper than every object before it, since nothing is hashed during the scan. |
| Corrupt or forged objects | Packs are indexed by isomorphic-git or gix, which recompute every object id. A damaged pack is refused. |
| Malicious ref names (`../x`, `-x`, `x.lock`, `@{`) | Refs are built only from validated ids (`refs.ts`). Refs read from outside must pass `isSafeRefName`, a strict subset of `git check-ref-format`; anything else is reported and not created. |
| Forged commit metadata or trailers | Every value written is cleaned: no line breaks, no control or line-separator characters, and a length cap. Every value read is parsed as untrusted and cleaned again. Contributor names are labelled `(unverified)`. Git author fields are labels, never authorization. |
| SHA-256 or partial histories | Refused by name, never half-read. |
| Two tabs or windows writing one branch | Refs move only by compare-and-swap. A per-copy Web Lock gives one recording editor per copy; others are read-only. |
| Crash mid-operation | The journal protocol (ADR-3). Recovery never deletes a working copy, a recovery copy or a ref. |
| Storage exhaustion | A history write that fails for quota pauses history with a clear status. Autosave and drawing continue. History never deletes revisions to make room. |
| Untrusted IPC (desktop) | Commands take repository ids, validated and resolved only under the app's history folder. Paths from the page are never used. Every payload is bounded. |
| Exposure of removed content | History keeps what a diagram once contained. Settings → History says so; export of a diagram never includes history; removing history is explicit and confirmed, and says it does not reach published or exported copies. A history another diagram on the device continues is kept for it, and the confirmation says so; deleting it for both is a separate, confirmed action. |
| A merge that hides a broken combination | The combined document is validated whole. Anything `repairReferences` or `normalizeDocument` would drop or repair, and any containment cycle, becomes a conflict the person sees and decides, never a silent repair. Finishing re-checks both branch tips and the live content, so a newer edit is never overwritten (ADR-7). |
| An agent reading or changing history over MCP | `diagram_history` is read-only: summaries, diffs and previews of a restore or merge, for the open diagram only, by revision id. It runs no Git and exposes no ref names, paths or other diagrams. Reading a past revision in full needs **Let agents read past revisions in full**, off by default. A milestone suggestion changes nothing until the person accepts it (ADR-13). |
| History leaking through a live session | Collaboration never transmits history, and guests cannot open the owner's. Only the owner records. Contributor names come from the session, are credited only for changes the revision contains, and are written `(unverified)`. Ending a session triggers a capture so its changes are recorded with their contributors before the authorship record is discarded (ADR-12). |

## What history never does

- It never runs a repository's hooks, filters, merge drivers or helpers. gix and isomorphic-git have
  none in the paths used.
- It never writes into a user's own repository unless the person asks to commit the diagram there.
  Even then, it changes no other file, leaves the working tree alone, and touches the index only for
  the diagram, and only when committing to the current branch. It never force-pushes.
- It never uploads anything without the person's explicit choice. Collaboration never transmits
  history.

## Running Git for remotes and project repositories (desktop)

Publishing a history and committing into a project repository run the person's own `git`
(`src-tauri/src/history/gitcli.rs`). Git is powerful and configurable, and a project repository may
come from anyone, so every call is made from a fixed, minimal starting point.

#### The executable and environment

- `git` is resolved once from absolute `PATH` entries, never the working directory, then
  canonicalised. It is run by absolute path with no shell. Version 2.38 or later is required.
- The environment is cleared and rebuilt from an allowlist: the home and profile folders, the SSH
  agent socket, and what a keyring helper needs. `PATH` is limited to Git's own and the system's
  folders. No `GIT_*` or `SSH_*` variable from outside gets through.
- The following are always set:
  - `GIT_CONFIG_NOSYSTEM`
  - `GIT_TERMINAL_PROMPT=0`
  - `GIT_ATTR_NOSYSTEM`
  - `GIT_NO_REPLACE_OBJECTS`
  - `GIT_OPTIONAL_LOCKS=0`
  - `GIT_PROTOCOL_FROM_USER=0`
  - `GIT_ALLOW_PROTOCOL=https:ssh`
  - `GIT_NO_LAZY_FETCH`
  - `GIT_LITERAL_PATHSPECS`
  - `LC_ALL=C`
- Git runs in an empty folder of the app's. The repository is passed explicitly with `--git-dir`
  and `--work-tree`.

#### Overrides on every call

- Hooks go to an empty folder. `core.fsmonitor`, `core.sshCommand`, `core.askPass` and
  `diff.external` are off.
- Hooks defined in the person's own configuration (Git 2.50's `hook.<name>.command`), which an
  empty hooks folder does not stop, are switched off by name on every call. Their names are read
  when the app starts.
- Credential helpers are reset, then re-added only when they are a known helper read from the
  person's global or system configuration.
- Only https and ssh are allowed. Submodules are never recursed into.
- Fetched objects are checked with `transfer.fsckObjects`. Automatic garbage collection is off.

#### Repository configuration

A project repository's own configuration is read without following includes, before Git runs in the
repository at all. Draft Canvas refuses to run Git there if it names anything Git would execute or
anything that changes where Git connects:

- includes
- hooks, including configuration-defined `hook.*` commands
- filters and textconv
- credential and other helpers
- `gpg.program`
- SSH or proxy commands
- upload and receive packs
- `url.*.insteadOf`
- any `http.*` setting, and `remote.*.proxy`
- `core.worktree`
- mirror remotes
- object alternates

A `.git` file is followed only to a genuine linked worktree that points back to it. A symlinked
`.git` is refused.

#### Remotes

- **Addresses:** only `https://` and SSH. An address with embedded credentials, control characters,
  a leading `-`, `ext::`, `fd::` or `file:` is refused. The address Git will actually use, after any
  rewriting, is checked again.
- **Fetch:** objects land in a holding area. Only branches whose every commit is a diagram history
  become remote-tracking branches. A fetch never touches the diagram.
- **Push:** explicit refspecs only, never forced. The first push to a destination is previewed in
  the page and confirmed in a native dialog, and the shell remembers the confirmation.
- **Failures:** errors are classified (sign-in, unknown host key, offline, rejected, timeout and so
  on). The text shown has credentials and control characters removed.

#### Project repositories

- **The diagram's own branch:** its commit is built by tree construction, with exactly one path
  replaced. The branch moves by compare-and-swap. HEAD, the index and the working tree are never
  touched.
- **The current branch:** allowed only when every precondition holds, checked again in the same
  step. The same commit is built, the branch moves by compare-and-swap from the HEAD the person saw,
  and then exactly the diagram's index entry is updated.
- **Path checks:** the diagram's path must be a normalised regular file inside the work tree. It
  must not be reached through a symlink, a submodule or a sparse-excluded folder. A path with filter
  or line-ending attributes that would change the file is refused.
- **Push:** only the diagram's own branch or the current branch can be pushed, after a preview of
  every commit it would publish.

#### Bounds

- Every call has a timeout: 120 seconds for network calls.
- Output is capped.
- On cancel or timeout, the whole process tree is killed, by a Windows job object or a Unix process
  group.
- Repository identifiers and file handles come from the shell. A path from the page is never
  trusted.
