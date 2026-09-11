# Architecture semantics

The contributor-facing reference for what Draft Canvas actually understands about the diagrams you
draw — the concrete rules, not the reasoning behind them (for that, see
[`docs/ARCHITECTURE.md`'s Relationship model](ARCHITECTURE.md#relationship-model)). Everything below
is implemented and tested (`tests/connector-semantics.test.ts`, `tests/edge-semantics.test.ts`,
`tests/edge-kinds.test.ts`, `tests/continuation.test.ts`).

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
| `component` | the Component shape, `componentKind` of `generic`/`module`/`adapter` — see below |
| `port` | Component shape with `componentKind: 'port'` — a contract, see below |
| `database` | Database shape, `databaseKind` of `generic`/`sql`/`nosql` |
| `cache` | Database shape, `databaseKind: 'cache'` |
| `fileSystem` | Database shape, `databaseKind: 'file-system'` |
| `objectStorage` | Database shape, `databaseKind: 'object-storage'` |
| `searchIndex` | Database shape, `databaseKind: 'search-index'` |
| `queue` | Queue shape, `queueKind` of `queue`/`stream` |
| `topic` | Queue shape, `queueKind: 'topic'` |
| `deadLetter` | Queue shape with `deliveryRole: 'dead-letter'` — the DLQ "Add DLQ" generates |
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
duplicated table. `componentKind` Generic/Module/Adapter never affect this — none of those three
carries its own relationship rule.

**Port** is the one Component kind that does. A port is a *contract* — the interface an
application core, a plugin host, or a module defines and something else implements or calls — not
a thing that does work, so it takes part in exactly two relationships: it is called (by a Service)
or used (by a Component), and it is implemented by whatever sits behind it. It gets its own
category and its own rows, and never folds to `service` or `component`: an unlisted pairing that
touches a port stays neutral rather than inheriting verbs a contract can't have. Every arrow keeps
its runtime direction; the word `implemented by` on the connector *leaving* a port is what says the
thing after it depends on the port's owner — dependency inversion, stated rather than drawn
backwards.

**Dead-letter queue** works the same way on the messaging side: a DLQ resolves to `queue` for every
pairing without its own row (a re-drive worker consumes it exactly like any queue), and has its own
category only so the pairing that *feeds* it — Queue → DLQ — can carry its own rule.

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
| Queue → Dead-letter queue | deadLetters, dependsOn | deadLetters | `failure` behaviour and a dashed (`async`) line — the same edge "Add DLQ" generates; `deliveryAttempts` captions it "after N attempts" |
| Topic → Dead-letter queue | dependsOn | *(none)* | **`status: 'unusual'`** — a topic never dead-letters; retries and a DLQ belong to each consumer's own queue |
| Service → Service | calls, http, grpc, command, query, event, dependsOn | calls | the one pairing with a full sync/async/callback/conditional/retry/failure/fallback picker |
| Service → External | same as Service → Service | calls | `external` is a flavour of `service` for any pairing without its own row |
| Component → Component | uses, dependsOn, calls | uses | an in-process dependency, never a network call; checked before the `service` fold |
| Service → Port | calls, dependsOn | calls | |
| Component → Port | uses, dependsOn | uses | |
| Port → Component / Service | implementedBy, dependsOn | implementedBy | the thing after the port depends on the port's owner |
| Port → Database | dependsOn | *(none)* | **`status: 'unusual'`** — a port is a contract; something implements it and talks to the store |
| Actor → Service | calls, http, command, query | calls | synchronous by predetermination, no behaviour picker |
| Database → Database | ingests, replicates, cdc, syncs, dependsOn | ingests | data movement, not a request/response shape |

A relation offered here is a *suggestion*, never a restriction — the inspector always keeps an
edge's current value selectable even if it's not in the list.

A pairing marked `status: 'unusual'` — **Queue → Topic** (a queue doesn't typically publish into a
topic), **Topic → Dead-letter queue** (a topic never dead-letters), **Port → Database** (a contract
wired straight to storage), and a Gateway routing straight into storage — is still drawable with no
friction: the inspector shows a small marker and a guidance
note. Queue → Topic additionally offers a one-click **Insert Worker** fix that splices a service node
in between and re-derives both new connectors' semantics from the matrix.

A capability may also set `defaultAsync`, asking a freshly inferred connector for a dashed line as
well as its default behaviour. Only Queue → Dead-letter queue does today: `failure` has no dash
pattern of its own, and dead-lettering is genuinely asynchronous. Everything else leaves dashing to
the behaviour (`event` dots its own line) or to the user.

## Two independent vocabularies

- **`EdgeSemantic`** — what the connection *represents*: `http`, `grpc`, `event`, `command`,
  `query`, `reads`, `writes`, `publishes`, `consumes`, `calls`, `dependsOn`, `fansOut`,
  `deliversTo`, `ingests`, `replicates`, `cdc`, `syncs`, `deadLetters`, `invalidates`, `watches`,
  `searches`, `indexes`, `routes`, `triggers`, `uses`, `implementedBy`. A label convenience only —
  never changes the connector's colour.
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

## Intent Continuation rules

The next moves Draft Canvas will sketch for a selected node (see
[`docs/ARCHITECTURE.md`'s Intent Continuation](ARCHITECTURE.md#intent-continuation)). Every
connector a rule adds is inferred from the capability matrix above — a rule that proposed a pairing
the matrix does not offer, or flags `unusual`, is dropped by the engine before it can show. Order
is ranking. `primary` may appear unprompted on selection; `secondary` only in the picker a
connector dropped on empty canvas opens.

<!-- continuation-rules:start — generated from `src/continuation/rules.ts`; `tests/continuation.test.ts` fails on drift -->
| Rule | Tier | Adds | Reason |
| --- | --- | --- | --- |
| `topic-fan-out-queue` | primary | Queue | This topic has a publisher but no delivery path. |
| `topic-fan-out-worker` | secondary | Worker | Subscribers can also receive directly from the topic. |
| `queue-consumer` | primary | Worker | This queue has no consumer. |
| `queue-dead-letter` | secondary | Dead-letter queue | This queue has a consumer but no dead-letter path. |
| `stream-dead-letter` | secondary | Dead-letter topic | This stream has a consumer but no dead-letter path. |
| `gateway-route` | primary | Service | This gateway doesn't route to anything yet. |
| `scheduler-trigger-service` | primary | Service | This scheduler doesn't trigger anything yet. |
| `scheduler-trigger-worker` | secondary | Worker | A scheduled job is usually a Worker. |
| `object-storage-fan-out-queue` | primary | Queue | Uploads here have nowhere to notify yet. |
| `object-storage-fan-out-topic` | secondary | Topic | Multiple subscribers can watch this bucket through a topic instead. |
| `port-implementation-component` | primary | Component | This port isn't implemented by anything yet. |
| `port-implementation-service` | secondary | Service | A port can also be implemented by a whole service. |
| `worker-indexes` | secondary | Search Index | This worker doesn't index anything yet. |
<!-- continuation-rules:end -->

Deliberately no rule starts from a plain Service, an Actor, a Data Store, a Cache, a File System, a
Search Index or a bare (non-Port) Component: each has too many valid next moves for any one of them
to be *the* move, and no suggestion beats a weak one. Adding a rule for one category is never
license to assume a neighboring one is now covered too — see `tests/continuation.test.ts`'s broad
silence sweep.
