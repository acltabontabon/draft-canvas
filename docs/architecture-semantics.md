# Architecture semantics

This is the contributor-facing reference for what Draft Canvas actually understands about the
diagrams you draw — the concrete rules, not the reasoning behind them. For the "why" (module
boundaries, how this fits into rendering and the store), see
[`docs/ARCHITECTURE.md`'s Relationship model section](ARCHITECTURE.md#relationship-model). For how
to propose a new rule, see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

Everything below is implemented and tested today (`tests/connector-semantics.test.ts`,
`tests/edge-semantics.test.ts`, `tests/edge-kinds.test.ts`). One tier of the model
(`'questionable'` status, see the end of this document) exists in the type system with nothing
wired up to it yet — that's called out explicitly where it comes up, not glossed over.

## The one rule everything else follows

> The user decides what connects. Draft Canvas decides how to make it look good — and, where it
> can, what it probably means.

A connection is never rejected. The semantics model only ever does two things: **infer** a sensible
default when you draw a fresh connection, and **nudge** when a connection looks architecturally
unusual, with an optional one-click fix. It never blocks, and it never overwrites a choice you made
on purpose.

## Node categories

Draft Canvas reasons about connections using `NodeCategory` — coarser than a node's shape
(`DraftNodeType`), finer than "ignore the node entirely." Most categories come from a node's
*sub-kind*, not a distinct shape:

| Category | Derived from |
| --- | --- |
| `actor` | the Actor shape |
| `service` | the Service shape, any `serviceKind` except `external` |
| `external` | Service shape with `serviceKind: 'external'` |
| `database` | Database shape, `databaseKind` of `generic`/`sql`/`nosql` |
| `cache` | Database shape, `databaseKind: 'cache'` |
| `fileSystem` | Database shape, `databaseKind: 'file-system'` |
| `objectStorage` | Database shape, `databaseKind: 'object-storage'` |
| `searchIndex` | Database shape, `databaseKind: 'search-index'` |
| `queue` | Queue shape, `queueKind` of `queue`/`stream` |
| `topic` | Queue shape, `queueKind: 'topic'` |
| `junction` | the Junction (ellipse) shape — see below |
| `generic` | text, note, code, and group — no relationship rule applies to these |

`sql`/`nosql` both read as plain `database`, and `stream` reads as plain `queue`: each gets its own
*silhouette* caption, but the same relationship vocabulary as the generic case — the product doesn't
currently draw a technical distinction there.

## The capability matrix

`src/document/connectorSemantics.ts`'s `MATRIX` is the single source of truth, keyed by
`source category > target category`. It's deliberately sparse: a pairing with no entry (queue↔queue,
actor↔database, anything touching `generic`, …) has no opinion at all, and behaves exactly like a
plain, unrestricted connector always has.

| Source → Target | Relations offered | Default | Notes |
| --- | --- | --- | --- |
| Service → Database | writes, reads, query, dependsOn | writes | |
| Database → Service | reads, query, dependsOn | reads | |
| Service → Cache | writes, reads, invalidates, dependsOn | writes | `invalidates` is cache-only — evicting a copy is a different move than writing through to a system of record |
| Cache → Service | reads, dependsOn | reads | |
| Service → File System | reads, writes, watches, dependsOn | writes | |
| File System → Service | reads, dependsOn | reads | |
| Service → Object Storage | reads, writes, dependsOn | writes | |
| Object Storage → Service | reads, dependsOn | reads | |
| Object Storage → Queue/Topic | publishes, event, dependsOn | publishes | object storage is the one storage kind that legitimately triggers a downstream event (e.g. "object created") |
| Service → Search Index | searches, indexes, dependsOn | searches | |
| Service → Queue | publishes, command, event, dependsOn | publishes | |
| Queue → Service | consumes, deliversTo, event, dependsOn | consumes | |
| Service → Topic | publishes, event, dependsOn | publishes | |
| Topic → Service | deliversTo, consumes, dependsOn | deliversTo | a topic fans out to every subscriber, so the default reads differently than a queue's `consumes` |
| Topic → Queue | fansOut, deliversTo, dependsOn | fansOut | |
| Queue → Topic | dependsOn, event | *(none)* | **`status: 'unusual'`** — see below |
| Service → Service | calls, http, grpc, command, query, event, dependsOn | calls | the one pairing with a full behaviour picker (sync/async/callback/conditional/retry/failure/fallback) — genuinely ambiguous enough to need one |
| Service → External | same as Service → Service | calls | `external` is a flavour of `service` for any pairing without its own row |
| Actor → Service | calls, http, command | calls | synchronous by predetermination, no behaviour picker |
| Database → Database | ingests, replicates, cdc, syncs, dependsOn | ingests | data movement between two stores, not a request/response shape |

A relation offered in a row is a *suggestion*, never a restriction — the inspector always keeps an
edge's current value selectable even if it's not in the list, so a deliberately unusual choice, or
one loaded from an older file, is never hidden or reset.

## Two independent vocabularies

A connector's meaning is split into two axes that don't imply each other:

- **`EdgeSemantic`** — what the connection *represents*: `http`, `grpc`, `event`, `command`, `query`,
  `reads`, `writes`, `publishes`, `consumes`, `calls`, `dependsOn`, `fansOut`, `deliversTo`,
  `ingests`, `replicates`, `cdc`, `syncs`, `deadLetters`, `invalidates`, `watches`, `searches`,
  `indexes`. Purely a label convenience — it never changes the connector's color.
- **`ConnectorKind`** — how it *behaves*: `sync`, `async`, `event`, `callback`, `conditional`,
  `retry`, `failure`, `fallback`. This drives the solid/dashed line treatment and small glyphs, not
  the caption.

`event` happens to appear in both lists — that's a coincidence, not a shared field. A connector can
be `semantic: 'event'` and `kind: 'retry'` at the same time.

Neither axis is a protocol taxonomy. Draft Canvas isn't trying to model REST vs. gRPC vs. GraphQL as
distinct first-class concepts — `http`/`grpc` exist as label conveniences for the one pairing
(service-to-service) ambiguous enough to want them, not as the start of a wire-protocol catalog.

## Junctions are semantics-transparent

The Junction shape (an ellipse) organizes topology and has no meaning of its own. A connection
through one is resolved by looking at what actually feeds it: `Service → Junction → Database` still
infers `writes`, the same as a direct connection would. If a Junction has no clear single category on
one side — nothing feeding it, or two different categories converging — it resolves to `'junction'`
itself, which is the model's own "I don't know, don't guess" signal, and the connector falls back to
the full, unrestricted vocabulary.

## Nudging, not blocking: a worked example

Exactly one pairing carries `status: 'unusual'` today: **Queue → Topic**. A queue doesn't typically
publish into a topic — normally something consumes the queue and forwards the message onward. Drawing
that connection anyway works fine — nothing is blocked — but the inspector shows a small amber
marker and a guidance note, with a one-click **Insert Worker** fix that splices a service node in
between and re-derives both new connectors' semantics from the matrix.

That's the whole pattern for "this is unusual, but you're the one who knows the system": a status, a
plain-language reason, and an optional way to resolve it — never a rejected connection.

## Future direction: `'questionable'` status

`RelationshipStatus` also defines a `'questionable'` tier, one step stronger than `'unusual'` — but
**no pairing uses it today**. It exists in the type system as a documented placeholder for a future
rule that would warrant firmer guidance than a nudge, not as something currently in effect. If you're
looking for a first architecture-semantics contribution, wiring a genuinely-questionable pairing to
this tier (with the same "guide, never block" posture) is a reasonable place to start — see
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for what makes a new rule technically defensible enough to
propose.
