# Canvas Evolution: design and security

Canvas Evolution keeps each diagram's history as standard Git, recorded in the background. This page
holds its design decisions, invariants and threat model; the person-facing guide is
[Diagram history](../guides/history.md).

## Three layers, kept apart

| Layer | Responsible for | Never |
| --- | --- | --- |
| Working copy (autosave, desktop recovery copies) | Durability of what is on screen, crash recovery | Waits on history |
| History | Revisions, timeline, compare, alternatives, restore, merge | Changes the working copy except through an explicit, journaled operation |
| Remote (desktop, opt-in) | Fetch and publish | Runs without an explicit choice; force-pushes; touches local capture |

## Decisions

### ADR-1: reuse Git implementations, own only the semantics

- The web backend is isomorphic-git in the history worker (`src/evolution/worker.ts`), which
  installs a global `Buffer` before isomorphic-git loads (`bufferGlobal.ts`). The editor's thread
  loads neither, and isomorphic-git's HTTP client is never imported.
- The desktop backend is gix in the shell (`src-tauri/src/history/`), with network features off. It
  gives true compare-and-swap ref transactions and repositories that standard Git reads in place.
- Draft Canvas owns only what neither library provides: bundle header framing (`bundle.ts`), a
  bounded pack pre-scan (`packScan.ts`), an IndexedDB file system whose writes commit before they
  resolve (`browser/kvfs.ts`), compare-and-swap on isomorphic-git under a Web Lock, and a bounded
  history walk so both backends list revisions in the same order.
- `VersionStore` and `HistoryBackend` (`contracts.ts`, `backend.ts`) are the editor's only Git
  surface. Both backends and real `git` must reproduce the commit ids in
  `tests/fixtures/evolution/contract.json`, and the real-Git tests are mandatory under `CI`.
  Regenerate the fixtures (`npx tsx tests/fixtures/evolution/generate.ts`) only for a deliberate
  format change.
- Bundles round-trip with standard Git in both directions, deltas included. Only SHA-1 histories
  are supported; SHA-256 and partial (filtered) bundles are refused by name.

### ADR-2: identity: history follows the working copy

| Concept | What it is |
| --- | --- |
| Document identity | `metadata.id`: a lineage hint that travels with the file, so two files may share it |
| History identity | `repoId`, minted when a history starts |
| Working copy | A library entry (`lib_<id>`), a Quick Draft (`draft_<recovery id>`) or a saved file (`file_<path>`) |
| Binding | `copyId → { repoId, altId, paused }`, kept beside the histories, never in the file |
| Alternative | A stable `altId`; its branch is `refs/heads/alt/<altId>`, and its name is display only |
| Editor session | One history session per open working copy (`service.ts`), a token every async step checks |
| Generation | `editorStore.revision`, which grows with every edit and load |

- Histories are never joined or forked on `metadata.id` alone (`identity.ts`). An unbound copy whose
  id matches a history is offered **Continue its history** or **Start new history**, and nothing is
  captured until the person answers.
- One editor records a copy, holding that copy's Web Lock for the session (`bridge.ts`). Another tab
  shows history read-only. Where the browser has no Web Locks, history is off and the status says
  so.
- A repository's lock serialises only ref updates and `repo.json` changes, each read again under it
  (`changeMeta`). Copies on different alternatives of one history record at once, each moving only
  its own branch.
- The active alternative and the pause live in the binding, so copies of one history never fight
  over a "current branch" and pause separately. `repo.json`'s old `paused` is only read, and lifted
  on resume.
- Removing history from one copy deletes only its binding while another copy is bound. A deleted
  library diagram keeps its binding, so a restored backup returns to its history, but it no longer
  counts as another copy.

### ADR-3: one recoverable operation protocol

Checkpoints need no journal: objects are content-addressed and immutable, and one compare-and-swap
makes them reachable. Every other operation (switching alternatives, restoring, finishing a merge,
a remote fast-forward, adopting an external change) records `prepared → pointer-moved →
working-reconciled` in the repository's journal before each next step (`journal.ts`). Restore and
merge write their commit and move the branch before the editor changes, so a crash in between leaves
the old content on screen as uncaptured work.

| Interrupted after | Source of truth | Recovery |
| --- | --- | --- |
| `prepared`, pointer unmoved | Old ref and the autosaved working copy | Discard the entry |
| Pointer moved, working copy as it was | The new ref | Complete: load the target into the working copy |
| Pointer moved, working copy changed since | Both | Ask the person whether to finish or keep the diagram as it is. Both versions stay |
| Pointer moved elsewhere (another writer) | The other writer's ref | Discard as stale |
| `working-reconciled` | Everything is in place | Remove the entry |

A switch whose binding had already moved asks the same way. Until the person answers, nothing is
recorded on either alternative; keeping the diagram as it is puts the binding back on the
alternative it left.

Durability: the desktop writes a temp file, fsyncs it and renames it, then fsyncs the directory on
Unix, or replaces atomically with write-through on Windows; gix writes ref lock files. On the web,
each IndexedDB write is its own `durability: 'strict'` transaction, resolved once committed, and the
browser releases a dead tab's Web Locks.

### ADR-4: automatic history never writes to an external repository

Histories live only in the app's own storage: IndexedDB `draft-canvas-history` on the web,
`<app data>/history/<repoId>.git` on the desktop. Recording writes nothing to a project folder, even
one that is a Git repository (`desktop/history.ts`).

Publishing to a remote, or committing into a project's own repository, happens only when the person
asks and never holds up capture or the working copy. It runs the person's own `git`, as
[Running Git for remotes and project repositories](#running-git-for-remotes-and-project-repositories-desktop)
describes, driven by the page through `desktop/remoteHistory.ts`. Remote revisions come in through
the same merge as alternatives (`startMerge` with `remote`). Project commits go to the diagram's own
branch by default (`src-tauri/src/history/project.rs`). The web app has no remotes; it exports and
imports bundles only.

A file changed on disk and reloaded is recorded as a revision with `initiator: external`.

### ADR-6: one content model

A revision stores one file, `diagram.draftcanvas`: the canonical serialization of
`historyContent(file)` (`document/content.ts`). Only `metadata.updatedAt` and each room's camera are
pinned; every other durable field is kept exactly. "Nothing changed" means byte equality of that
text, which is blob-id equality, and `tests/evolution/content-diff.test.ts` holds the semantic diff
to the same answer. Old revisions are never rewritten: like an old file, they are migrated in memory
when read (`snapshot.ts`).

### ADR-7: a semantic three-way merge, decided by the person

`evolution/merge.ts` runs in the history worker and merges documents, never text, matching changes
by id (`collab/diff.ts`). These units merge as one; everything else merges field by field.

| Unit | Fields merged as one |
| --- | --- |
| Connector ends | `source`, `target`, both anchors, `portal` |
| Connector path | `routing`, `routeMode`, `waypoints` |
| Geometry | `x`, `y`, `width`, `height` |
| Containment | `parentId`, and which room the element is in |
| Junction link | `link`, and the label a linked Junction shares with its group |
| Sequence | The whole payload |
| Style | The diagram's whole style, drawings included |

- Conflicts are never last-writer-wins. The same change on both sides is not a conflict; anything
  else both sides touched waits for the person to choose a side: `both-changed`,
  `removed-and-changed`, `same-id`, `moved-apart`, and `file` (title, settings, style, level or
  order). The candidate shown meanwhile resolves open conflicts toward `ours`, and finishing needs a
  choice for every one (`mergeReady`).
- The combination is applied to the ancestor and validated whole. Whatever `repairReferences` would
  drop, a boundary the two sides together put inside itself, and any repair `normalizeDocument`
  would make become `combination` conflicts, never silent repairs.
- When the other side is already included, or ahead, there is no merge commit. A side that
  is ahead is fast-forwarded through the ADR-3 protocol and applied as one undo step.
- Several merge bases fold pairwise (`virtualBase`) only when each pair has one common ancestor and
  merges cleanly; otherwise the person merges step by step. Histories with no common ancestor are
  refused.
- A merge session survives a reload: its choices are kept in the journal
  (`kind: 'merge-session'`), and `refs/draft-canvas/merge/<id>/theirs` keeps the other side's
  objects reachable. It is offered back only while its `ours` is still the tip. **Cancel** removes
  both.
- Finishing re-checks both branch tips and the blob id of the live content, so a collaborator's
  newer edit is never overwritten merely because the branches did not move. The result is applied
  with `applyToFile` at the generation the session began at; if the editor moved meanwhile, the
  merge stays in history, nothing on the canvas is replaced, and the person is asked.
- The candidate can't be edited on the canvas. Further changes are ordinary edits after the merge.

### ADR-8: checkpoint semantics

An edit only marks the copy dirty. A revision is recorded at a boundary (no gesture held), after
30 s of quiet or 120 s of steady editing, both set in **Settings → History**. Agent commits
(`host/agentBridge.ts`) are coalesced and recorded once the agent has been quiet for 3 s. One
capture runs at a time; a failure retries with backoff and shows in the status, and drawing and
autosave never wait. An undo back to the recorded content records nothing. Messages are
deterministic and factual (`summary.ts`), with trailers sanitised both ways (`trailers.ts`).

### ADR-9 and ADR-11: the timeline and the history lens

- The timeline always ends in **Live**, the diagram as it is now: an endpoint, not a revision.
- Sessions (a gap of more than 20 minutes starts a new one) are presentation only. Git's history
  underneath is never collapsed.
- The lens (`canvas/HistoryLens.tsx`) draws a revision with `renderDocumentSvg`, from the same
  display lists as the canvas and every export, in the revision's own style and routing. There is no
  history-only drawing, so canvas-only chrome (selection, handles, the ring around linked Junctions)
  is not shown. The live canvas keeps receiving changes under it, and `uiStore.historyLens` makes the
  editor read-only while it is up.
- Camera moves are decided in pure `presentation/revisionFraming.ts`, and happen only when
  **Follow changes with the camera** is on.
- Compare (`canvas/CompareLayers.tsx`) gives every change a mark and a glyph, never colour alone.

### ADR-12: history in live collaboration

- Only the owner's editor records, from the owner's canvas. Guests get no history: it holds content
  the owner removed, a guest's copy is never saved, `src/collab/` does not import history, and no
  collaboration message carries it.
- A person is credited only when the revision contains their change: `collabBridge.ts`'s
  `historyAttribution` intersects the keys the revision changed with the session's authorship
  touches. Names are written as `Draft-Canvas-Contributor: <name> (unverified)`.
  `Draft-Canvas-Collab-Seq` records the owner's collaboration commit number at capture.
- Ending a session (`stopHosting`) requests a capture before the authorship record is discarded.
- Switching, exploring and merging alternatives are refused during a session: each would replace
  everyone's diagram at once. **Restore** and **Bring back** are ordinary edits through
  `applyToFile`, with the generation check.

### ADR-13: `diagram_history`, a reviewed view for agents

The page that has the diagram open serves the tool (`store/evolution/agentTool.ts`) through the
desktop broker; another diagram answers `NOT_ACTIVE`. The tool is annotated `readOnlyHint: true`,
addresses revisions only by the 40-hex ids `list` returns, and exposes no raw Git, ref names, Git
commands or other diagrams' histories. Restoring, merging, switching and naming stay the person's
actions.

| Action | Class | Returns |
| --- | --- | --- |
| `summary` | Read: summaries | Current revision id, alternative, alternatives, milestones, whether a capture is pending |
| `list` | Read: summaries | Up to 100 revisions, newest first; `query` filters |
| `compare` | Read: summaries | The semantic diff (up to 200 elements) and its wording, between two revisions or a revision and `live` |
| `preview_restore` | Preview | What restoring a revision would change. Never applied |
| `preview_merge` | Preview | How much combines and which conflicts need a decision. Never applied |
| `suggest_milestone` | Request | A suggestion in the history details; nothing is named until the person accepts |
| `read` | Full content | A whole past revision, only when **Let agents read past revisions in full** is on (`history-agents-read`, off by default); otherwise `READ_ONLY` |

Error codes: `NOT_ACTIVE`, `NOT_FOUND` (no history, unknown alternative), `READ_ONLY` and
`INVALID_INPUT`.

### ADR-15: storage policy

History never deletes a reachable revision to free space; a quota failure pauses history instead.
The history service runs maintenance in the background after every 40 revisions it records.

- Web: revisions are written as loose objects. Maintenance packs the reachable ones into one pack
  without deltas (isomorphic-git writes none), so a packed history is larger than Git's own `gc`
  would make it. It removes unreachable loose objects older than 14 days, and skips a repository
  with an open journal entry. Measured growth is about 1.1 MB per 100 revisions of a 160 KB
  diagram, packed or loose (`benchmark/history.ts`).
- Desktop: maintenance only removes unreachable loose objects older than 14 days. Running `git gc`
  by hand on the repository works.

## Invariants

- `src/evolution/` is React-free, store-free and DOM-free. It may import only `document/`, `depth/`,
  the canonical serializer and the listed pure `collab/` helpers (`tests/layering.test.ts`).
- History work runs in the history worker or the desktop shell. The drawing thread only hands over
  an immutable snapshot.
- History state in the editor (`store/evolution/evolutionStore.ts`) is never saved, undone, shared
  or exported.
- Only a journaled operation changes the working copy, through `editorStore.applyToFile` as one undo
  step.
- An operation that replaces the canvas with a recorded revision (switching, exploring, bringing an
  alternative in) starts only from the branch's tip. While recording is paused or off, `flush`
  records nothing, so the operation is refused if anything is unrecorded.
- Refs move only by compare-and-swap. Every ref name is built from ids (`refs.ts`), and every ref
  read from outside passes `isSafeRefName`.
- Every revision read back passes `parseDocument`, and its tree must be exactly
  `{ diagram.draftcanvas }`.

## Security

Everything history reads from outside the running editor is untrusted: repositories on disk,
bundles, fetched objects, commit metadata, collaboration messages and requests over the desktop
shell's IPC.

| Asset | Where | Who may change it |
| --- | --- | --- |
| A diagram's history | See ADR-4 | The editor recording that working copy; the person's explicit actions |
| Working-copy bindings | Web: the history database. Desktop: `history/bindings.json` | The history service |
| The person's Git identity label | `localStorage` preferences | The person, in **Settings → History** |
| Credentials for remotes | The person's own credential helper or keychain | Never Draft Canvas |

### Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Malicious bundle: path traversal, odd trees, foreign files | Import runs into a new, unbound repository. Every revision any ref reaches must have a tree of exactly `100644 blob diagram.draftcanvas`, and its blob must pass `parseDocument`; otherwise the whole repository is removed. No tree path is ever written to a file system. |
| Decompression bombs, giant objects, deep delta chains | `packScan.ts` walks the pack before any library inflates it, reading each object's stream to its exact end and counting the output against its declared size. Limits: 24 MB per object, 2 GB inflated in total, delta depth 4096, and a bounded object count. Nothing is hashed during the scan, so a delta that names its base by id counts as one level deeper than every object before it. |
| Corrupt or forged objects | isomorphic-git or gix indexes each pack and recomputes every object id. A damaged pack is refused. |
| Malicious ref names (`../x`, `-x`, `x.lock`, `@{`) | A ref read from outside must pass `isSafeRefName`, a strict subset of `git check-ref-format`; anything else is reported and not created. |
| Forged commit metadata or trailers | Values are cleaned when written and again when read: no line breaks, no control or line-separator characters, and a length cap. Contributor names are labelled `(unverified)`. Git author fields are labels, never authorization. |
| SHA-256 or partial histories | Refused by name, never half-read. |
| Two tabs or windows writing one branch | Compare-and-swap ref moves and one recording editor per copy (ADR-2). |
| Crash mid-operation | The journal protocol (ADR-3). Recovery never deletes a working copy, a recovery copy or a ref. |
| Storage exhaustion | A history write that fails for quota pauses history with a clear status. Autosave and drawing continue. |
| Untrusted IPC (desktop) | Commands take repository ids, validated and resolved only under the app's history folder. Paths from the page are never used. Every payload is bounded. |
| Exposure of removed content | History keeps what a diagram once contained, and **Settings → History** says so. Exporting a diagram never includes its history. Removing history is explicit and confirmed, and the confirmation says it does not reach published or exported copies. A history another diagram on the device continues is kept for it, and the confirmation says so; deleting it for both is a separate, confirmed action. |
| A merge that hides a broken combination | Validation conflicts and the re-check before finishing (ADR-7). |
| An agent reading or changing history over MCP | `diagram_history` is read-only and serves only the open diagram (ADR-13). |
| History leaking through a live session | Owner-only capture, no guest access, unverified contributor names (ADR-12). |

### Running Git for remotes and project repositories (desktop)

Publishing and project commits run the person's own `git` (`src-tauri/src/history/gitcli.rs`). A
project repository may come from anyone, so every call starts from a fixed, minimal setup. History
never runs a repository's hooks, filters, merge drivers or helpers (gix and isomorphic-git have none
in the paths used).

Every call:

- `git` 2.38 or later is resolved once from absolute `PATH` entries, never the working directory,
  then canonicalised. It runs by absolute path with no shell, in an empty folder of the app's, with
  the repository passed as `--git-dir` and `--work-tree`.
- The environment is rebuilt from an allowlist: the home and profile folders, the SSH agent socket,
  and what a keyring helper needs. `PATH` holds only Git's own and the system's folders, and no
  `GIT_*` or `SSH_*` variable from outside gets through. Always set: `GIT_CONFIG_NOSYSTEM`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_ATTR_NOSYSTEM`, `GIT_NO_REPLACE_OBJECTS`, `GIT_OPTIONAL_LOCKS=0`,
  `GIT_PROTOCOL_FROM_USER=0`, `GIT_ALLOW_PROTOCOL=https:ssh`, `GIT_NO_LAZY_FETCH`,
  `GIT_LITERAL_PATHSPECS` and `LC_ALL=C`.
- Hooks point to an empty folder, and hooks defined in the person's own configuration (Git 2.50's
  `hook.<name>.command`) are switched off by name. `core.fsmonitor`, `core.sshCommand`,
  `core.askPass` and `diff.external` are off.
- Credential helpers are reset, then only known helpers from the person's global or system
  configuration are re-added.
- Only https and ssh are allowed, submodules are never recursed into, fetched objects are checked
  with `transfer.fsckObjects`, and automatic garbage collection is off.
- There is a timeout (120 seconds for network calls) and an output cap. Cancel or timeout kills the
  whole process tree, through a Windows job object or a Unix process group.
- Repository identifiers and file handles come from the shell. A path from the page is never
  trusted.

Before Git runs in a project repository at all, its configuration is read without following
includes. Git is refused there if that configuration names anything Git would execute, or anything
that changes where Git connects: includes; hooks, including `hook.*` commands; filters and textconv;
credential and other helpers; `gpg.program`; SSH or proxy commands; upload and receive packs;
`url.*.insteadOf`; any `http.*` setting, and `remote.*.proxy`; `core.worktree`; mirror remotes;
object alternates. A `.git` file is followed only to a genuine linked worktree that points back to
it, and a symlinked `.git` is refused.

Remotes:

- Addresses are `https://` or SSH only. One with embedded credentials, control characters, a
  leading `-`, `ext::`, `fd::` or `file:` is refused, and the address Git will actually use, after
  any rewriting, is checked again.
- A fetch lands objects in a holding area and never touches the diagram. Only branches whose every
  commit is a diagram history become remote-tracking branches.
- A push uses explicit refspecs and is never forced. The first push to a destination is previewed
  in the page and confirmed in a native dialog, and the shell remembers the confirmation.
- Errors are classified (sign-in, unknown host key, offline, rejected, timeout and so on) and shown
  with credentials and control characters removed.

Project repositories:

- A commit to the diagram's own branch is built by tree construction with exactly one path replaced,
  and the branch moves by compare-and-swap. HEAD, the index and the working tree are never touched.
- A commit to the current branch is allowed only when every precondition holds, checked again in
  the same step. The branch moves by compare-and-swap from the HEAD the person saw, then exactly the
  diagram's index entry is updated. No other file changes, and the working tree is left alone.
- The diagram's path must be a normalised regular file inside the work tree, not reached through a
  symlink, a submodule or a sparse-excluded folder. A path with filter or line-ending attributes
  that would change the file is refused.
- Only the diagram's own branch or the current branch can be pushed, after a preview of every commit
  it would publish.
