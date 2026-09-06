# Architecture semantics

The contributor-facing reference for what Draft Canvas actually understands about the diagrams you
draw — the concrete rules, not the reasoning behind them (for that, see
[`docs/ARCHITECTURE.md`'s Relationship model](ARCHITECTURE.md#relationship-model)). Everything below
is implemented and tested (`tests/connector-semantics.test.ts`, `tests/edge-semantics.test.ts`,
`tests/edge-kinds.test.ts`).

## The one rule everything else follows

> The user decides what connects. Draft Canvas decides how to make it look good — and, where it
> can, what it probably means.

A connection is never rejected. The model only ever **infers** a sensible default when you draw a
fresh connection, and **nudges** when a connection looks architecturally unusual, with an optional
one-click fix.

## Node categories

Connections are reasoned about using `NodeCategory` — coarser than a node's shape, finer than
"ignore the node entirely." Most categories come from a node's *sub-kind*, not a distinct shape:

| Category | Derived from |
| --- | --- |
| `actor` | the Actor shape |
| `service` | the Service shape, any `serviceKind` except `external` |
| `external` | Service shape with `serviceKind: 'external'` |
| `component` | the Component shape, any `componentKind` — see below |
| `database` | Database shape, `databaseKind` of `generic`/`sql`/`nosql` |
| `cache` | Database shape, `databaseKind: 'cache'` |
| `fileSystem` | Database shape, `databaseKind: 'file-system'` |
| `objectStorage` | Database shape, `databaseKind: 'object-storage'` |
| `searchIndex` | Database shape, `databaseKind: 'search-index'` |
| `queue` | Queue shape, `queueKind` of `queue`/`stream` |
| `topic` | Queue shape, `queueKind: 'topic'` |
| `junction` | the Junction (ellipse) shape — see below |
| `generic` | text, note, code, and group — no relationship rule applies |

**Component** is a logical architectural building block inside a larger deployment or boundary — a
Use Case layer, a module, a ports-and-adapters adapter — never independently deployable, never a
network or process boundary. That distinction from Service is real and permanent: `categoryOf`
never collapses a Component into `service`, so a future capability that queries category can still
tell them apart. But the *relationship vocabulary* a Component participates in — reads, writes,
calls, depends on — is exactly Service's own: for matrix lookups only, Component resolves to
`service` the same way `external`/`worker`/`scheduler`/`gateway` already do (see "The capability
matrix" below), so Service → Database's "writes" default is also Component → Database's, with no
duplicated table. `componentKind` (Generic/Module/Adapter) never affects this — none of Component's
kinds carries its own relationship rule, unlike Service's.

## The capability matrix

`src/document/connectorSemantics.ts`'s `MATRIX` is the single source of truth, keyed by
`source category > target category`. Deliberately sparse — a pairing with no entry (queue↔queue,
actor↔database, anything touching `generic`, …) has no opinion and behaves like a plain,
unrestricted connector.

| Source → Target | Relations offered | Default | Notes |
| --- | --- | --- | --- |
| Service → Database | writes, reads, query, dependsOn | writes | |
| Database → Service | reads, query, dependsOn | reads | |
| Service → Cache | writes, reads, invalidates, dependsOn | writes | `invalidates` is cache-only |
| Cache → Service | reads, dependsOn | reads | |
| Service → File System | reads, writes, watches, dependsOn | writes | |
| File System → Service | reads, dependsOn | reads | |
| Service → Object Storage | reads, writes, dependsOn | writes | |
| Object Storage → Service | reads, dependsOn | reads | |
| Object Storage → Queue/Topic | publishes, event, dependsOn | publishes | object storage is the one storage kind that legitimately triggers a downstream event |
| Service → Search Index | searches, indexes, dependsOn | searches | |
| Service → Queue | publishes, command, event, dependsOn | publishes | |
| Queue → Service | consumes, deliversTo, event, dependsOn | consumes | |
| Service → Topic | publishes, event, dependsOn | publishes | |
| Topic → Service | deliversTo, consumes, dependsOn | deliversTo | a topic fans out to every subscriber |
| Topic → Queue | fansOut, deliversTo, dependsOn | fansOut | |
| Queue → Topic | dependsOn, event | *(none)* | **`status: 'unusual'`** — see below |
| Service → Service | calls, http, grpc, command, query, event, dependsOn | calls | the one pairing with a full sync/async/callback/conditional/retry/failure/fallback picker |
| Service → External | same as Service → Service | calls | `external` is a flavour of `service` for any pairing without its own row |
| Actor → Service | calls, http, command | calls | synchronous by predetermination, no behaviour picker |
| Database → Database | ingests, replicates, cdc, syncs, dependsOn | ingests | data movement, not a request/response shape |

A relation offered here is a *suggestion*, never a restriction — the inspector always keeps an
edge's current value selectable even if it's not in the list.

Exactly one pairing carries `status: 'unusual'` today: **Queue → Topic** (a queue doesn't typically
publish into a topic). Drawing it anyway works fine — the inspector shows a small marker and a
guidance note, with a one-click **Insert Worker** fix that splices a service node in between and
re-derives both new connectors' semantics from the matrix.

## Two independent vocabularies

- **`EdgeSemantic`** — what the connection *represents*: `http`, `grpc`, `event`, `command`,
  `query`, `reads`, `writes`, `publishes`, `consumes`, `calls`, `dependsOn`, `fansOut`,
  `deliversTo`, `ingests`, `replicates`, `cdc`, `syncs`, `deadLetters`, `invalidates`, `watches`,
  `searches`, `indexes`. A label convenience only — never changes the connector's colour.
- **`ConnectorKind`** — how it *behaves*: `sync`, `async`, `event`, `callback`, `conditional`,
  `retry`, `failure`, `fallback`. Drives the solid/dashed line and small glyphs, not the caption.

`event` appears in both lists by coincidence, not a shared field — a connector can be
`semantic: 'event'` and `kind: 'retry'` at once. Neither axis is a protocol taxonomy; `http`/`grpc`
exist as label conveniences for the one pairing (service-to-service) ambiguous enough to want them.

## Junctions are semantics-transparent

The Junction shape (an ellipse) organizes topology and has no meaning of its own. A connection
through one resolves by looking at what actually feeds it — `Service → Junction → Database` still
infers `writes`. If a Junction has no clear single category on one side, it resolves to
`'junction'` itself, and the connector falls back to the full, unrestricted vocabulary.
