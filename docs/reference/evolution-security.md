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
| Decompression bombs, giant objects, deep delta chains | `packScan.ts` walks the pack before any library inflates it. Output is counted per object against its declared size, objects are capped at 24 MB, the total inflated at 2 GB, deltas at depth 4096, and the object count is bounded. |
| Corrupt or forged objects | Packs are indexed by isomorphic-git or gix, which recompute every object id. A damaged pack is refused. |
| Malicious ref names (`../x`, `-x`, `x.lock`, `@{`) | Refs are built only from validated ids (`refs.ts`). Refs read from outside must pass `isSafeRefName`, a strict subset of `git check-ref-format`; anything else is reported and not created. |
| Forged commit metadata or trailers | Every value written is cleaned: no line breaks, no control or line-separator characters, and a length cap. Every value read is parsed as untrusted and cleaned again. Contributor names are labelled `(unverified)`. Git author fields are labels, never authorization. |
| SHA-256 or partial histories | Refused by name, never half-read. |
| Two tabs or windows writing one branch | Refs move only by compare-and-swap. A per-copy Web Lock gives one recording editor per copy; others are read-only. |
| Crash mid-operation | The journal protocol (ADR-3). Recovery never deletes a working copy, a recovery copy or a ref. |
| Storage exhaustion | A history write that fails for quota pauses history with a clear status. Autosave and drawing continue. History never deletes revisions to make room. |
| Untrusted IPC (desktop) | Commands take repository ids, validated and resolved only under the app's history folder. Paths from the page are never used. Every payload is bounded. |
| Exposure of removed content | History keeps what a diagram once contained. Settings → History says so; export of a diagram never includes history; removing history is explicit and confirmed, and says it does not reach published or exported copies. |
| A merge that hides a broken combination | The combined document is validated whole. Anything `repairReferences` or `normalizeDocument` would drop or repair, and any containment cycle, becomes a conflict the person sees and decides, never a silent repair. Finishing re-checks both branch tips and the live content, so a newer edit is never overwritten (ADR-7). |
| An agent reading or changing history over MCP | `diagram_history` is read-only: summaries, diffs and previews of a restore or merge, for the open diagram only, by revision id. It runs no Git and exposes no ref names, paths or other diagrams. Reading a past revision in full needs **Let agents read past revisions in full**, off by default. A milestone suggestion changes nothing until the person accepts it (ADR-13). |
| History leaking through a live session | Collaboration never transmits history, and guests cannot open the owner's. Only the owner records. Contributor names come from the session, are credited only for changes the revision contains, and are written `(unverified)`. Ending a session triggers a capture so its changes are recorded with their contributors before the authorship record is discarded (ADR-12). |

## What history never does

- It never runs a repository's hooks, filters, merge drivers or helpers. gix and isomorphic-git have
  none in the paths used.
- It never writes into a user's own repository, never changes their branch, index or working tree,
  and never force-pushes.
- It never uploads anything without the person's explicit choice. Collaboration never transmits
  history.

## Running Git for remotes and project repositories (desktop)

<!-- gitcli: filled in with the desktop remote feature -->
