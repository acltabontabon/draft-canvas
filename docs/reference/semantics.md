# Architecture semantics

Rules for connections and "what next?" suggestions. Rationale:
[Architecture](architecture.md#relationship-model).

A connection is never rejected. Draft Canvas infers a default for a fresh connector and shows
guidance when a pairing is unusual.

## Node categories

`categoryOf` in `src/document/connectorSemantics.ts` maps each node to a `NodeCategory`:

| Category | Derived from |
| --- | --- |
| `actor` | Actor shape: a person, group, third party or participating system |
| `agent` | Actor with `actorKind: 'agent'` |
| `device` | Actor with `actorKind: 'device'` |
| `service` | Service shape, `serviceKind` of `generic` or `api` |
| `external` / `worker` / `scheduler` / `gateway` | Service with that `serviceKind` |
| `component` | Component shape, `componentKind` of `generic`, `module` or `adapter` |
| `port` | Component with `componentKind: 'port'` |
| `database` | Database shape, `databaseKind` of `generic`, `sql`, `nosql` or `table` |
| `cache` / `fileSystem` / `objectStorage` / `searchIndex` | Database with `databaseKind` `cache`, `file-system`, `object-storage`, `search-index` |
| `queue` | Queue shape, `queueKind: 'queue'`: one message, one consumer |
| `topic` | Queue shape, `queueKind: 'topic'`: one message, every subscriber |
| `stream` | Queue shape, `queueKind: 'stream'`: a retained log each consumer group reads in full |
| `deadLetter` | Queue with `deliveryRole: 'dead-letter'` (what **Add DLQ** creates) |
| `junction` | Junction (ellipse) shape |
| `generic` | Every other shape (text, note, code, group): no rules apply |

### Folding

A pairing without its own row borrows one (`resolved()` and `capabilityFor`):

- `external`, `worker`, `scheduler`, `gateway` and `component` fold to `service`.
- `agent` and `device` fold to `actor`. `stream` folds to `topic`. `deadLetter` folds to `queue`.
- `port` never folds. A contract has no verbs of its own beyond its rows.
- Lookup order: exact pair, source folded, target folded, both folded. A dead-letter source only
  folds with both sides, so DLQ → DLQ stays unlisted.

## The capability matrix

`MATRIX` in `src/document/connectorSemantics.ts` is the source of truth, keyed
`source>target`. It is sparse on purpose: a pairing with no entry (Queue → Queue, Actor →
Database, anything touching `generic`) is an unrestricted connector with no default.

| Source → Target | Relations offered | Default | Notes |
| --- | --- | --- | --- |
| Service → Database | readsWrites, writes, reads, query, dependsOn | readsWrites |  |
| Database → Service | reads, query, cdc | reads |  |
| Service → Cache | reads, writes, readsWrites, invalidates, dependsOn | reads |  |
| Cache → Service | reads | reads |  |
| Service → File System | reads, writes, readsWrites, watches, dependsOn | writes |  |
| File System → Service | reads | reads |  |
| Service → Object Storage | reads, writes, readsWrites, dependsOn | writes |  |
| Object Storage → Service | reads | reads |  |
| Service → Search Index | searches, indexes, dependsOn | searches |  |
| Object Storage → Queue | publishes, event | publishes |  |
| Object Storage → Topic | publishes, event | publishes |  |
| Service → Queue | command, publishes, consumes, event, dependsOn | command | dashed by default |
| Queue → Service | consumes, deliversTo, command, event | consumes | dashed by default |
| Service → Service | calls, http, grpc, command, query, event, compensates, dependsOn | calls |  |
| Component → Component | uses, dependsOn, calls | uses |  |
| Service → Port | calls, implements, dependsOn | calls |  |
| Component → Port | uses, calls, implements, dependsOn | uses |  |
| Port → Component | implementedBy | implementedBy |  |
| Port → Service | implementedBy | implementedBy |  |
| Port → Database | dependsOn | *(none)* | unusual |
| Actor → Service | calls, http, command, query | calls |  |
| Actor → Actor | asks, delegates, notifies, uses | asks |  |
| Actor → AI Agent | asks, delegates, uses | asks |  |
| AI Agent → AI Agent | delegates, asks, calls | delegates |  |
| AI Agent → Actor | escalates, asks, notifies | escalates |  |
| Actor → Device | uses | uses |  |
| Device → Actor | notifies | notifies |  |
| AI Agent → Database | reads, query, readsWrites, writes | reads |  |
| AI Agent → Search Index | searches, indexes | searches |  |
| Device → Queue | publishes, command, event | publishes |  |
| Device → Topic | publishes, event | publishes |  |
| Service → Actor | notifies, event | notifies |  |
| Service → AI Agent | triggers, notifies, calls | triggers |  |
| Service → External | calls, http, grpc, command, event, compensates, dependsOn | calls |  |
| Service → Topic | publishes, event, dependsOn | publishes |  |
| Topic → Service | deliversTo | deliversTo |  |
| Topic → Queue | fansOut, deliversTo | fansOut |  |
| Service → Stream | publishes, consumes, event, dependsOn | publishes |  |
| Stream → Service | consumes, event | consumes |  |
| Topic → Search Index | indexes, ingests | indexes |  |
| Topic → Database | ingests | ingests |  |
| Queue → Topic | dependsOn, event | *(none)* | unusual; offers **Insert Worker** |
| Queue → Dead-letter queue | deadLetters | deadLetters | `failure`, dashed |
| Service → Dead-letter queue | deadLetters, publishes | deadLetters | `failure`, dashed |
| Topic → Dead-letter queue | dependsOn | *(none)* | unusual |
| Database → Database | ingests, replicates, cdc, syncs, transforms | ingests |  |
| Object Storage → Database | transforms, ingests | transforms |  |
| Worker → Search Index | searches, indexes, dependsOn | indexes |  |
| Scheduler → Service | triggers, calls, dependsOn | triggers |  |
| Scheduler → Worker | triggers, calls, dependsOn | triggers |  |
| Gateway → Service | routes, calls, dependsOn | routes |  |
| Gateway → Gateway | routes, calls, dependsOn | routes |  |
| Gateway → Database | dependsOn, writes, reads, query | *(none)* | unusual |
| Gateway → Cache | dependsOn, writes, reads, invalidates | *(none)* | unusual |
| Gateway → File System | dependsOn, reads, writes, watches | *(none)* | unusual |
| Gateway → Object Storage | dependsOn, reads, writes | *(none)* | unusual |
| Gateway → Search Index | dependsOn, searches, indexes | *(none)* | unusual |

- Offered relations are suggestions. The inspector keeps a connector's current value selectable.
- Unusual pairings draw normally, with a marker and guidance note. **Insert Worker** splices a
  Service between the Queue and Topic and re-infers both connectors.
- "Dashed" rows set `defaultAsync`. Topics and streams use the `event` behaviour's dotted line.
- Reconnecting, reversing or changing a node's kind re-infers only inferred relationships, and
  drops a dash only inference added. Explicit choices are kept.

## Captions read in the arrow's direction

A caption reads *source, verb, target*. When the arrow starts at the verb's object, the caption
turns passive (`relationLabel` in `src/document/edgeSemantics.ts`):

| Relationship | Arrow from the doer | Arrow from the other end |
| --- | --- | --- |
| reads, writes, query, searches, invalidates, watches | Service → Database: "reads from" | Database → Service: "read by" |
| readsWrites | "reads / writes" | "read / written by" |
| consumes | Worker → Queue: "consumes from" | Queue → Worker: "consumed by"; Stream → Worker: "read by" |
| ingests, indexes | | Topic → Database: "ingested by"; Topic → Search Index: "indexed by" |

- Other verbs have no passive form. `http` reads "calls over HTTP", `grpc` "calls over gRPC",
  `event` "emits", `command` "sends command to".
- Display only: `semantic` is never rewritten, and a typed label always wins.
- Sequence export sends a passive connector from its far end with the active caption
  (`Worker ->> Queue: consumes from`).

## Two independent vocabularies

- **`EdgeSemantic`**: what the connection represents. `http`, `grpc`, `event`, `command`,
  `query`, `reads`, `writes`, `readsWrites`, `publishes`, `consumes`, `calls`, `dependsOn`, `fansOut`,
  `deliversTo`, `ingests`, `replicates`, `cdc`, `syncs`, `deadLetters`, `invalidates`, `watches`,
  `searches`, `indexes`, `routes`, `triggers`, `uses`, `implements`, `implementedBy`, `compensates`,
  `transforms`, `asks`, `delegates`, `escalates`, `notifies`. Drives the caption, never the colour.
- **`ConnectorKind`**: how it behaves. `sync`, `async`, `event`, `callback`, `conditional`,
  `retry`, `failure`, `fallback`. Drives line style and glyphs, not the caption.

`event` appears in both by coincidence: a connector can be `semantic: 'event'` and `kind: 'retry'`
at once.

## Junctions are semantics-transparent

Inference looks through a Junction, including chained Junctions, to what feeds it:
`Service → Junction → Database` still infers `readsWrites`. A side with no single category
resolves to `junction`, with the unrestricted vocabulary.

Sequence export flattens `A → Junction → B` into one message (`resolveJunctionEndpoint`). The
Junction is a participant only when its side is ambiguous or dangling.

## Sequence Diagram interaction kinds

Each Sequence Diagram message is `sync`, `async` or `response` (`InteractionKind` in
`src/sequence/label.ts`). Nothing new is stored on the document.

- `response`: the reply synthesized for a connector with `hasResponse`.
- `async`: `semantic` is `publishes`, `consumes`, `deliversTo`, `fansOut` or `deadLetters`; or
  `kind` is `event` or `async`; or the connector's `async` flag is set.
- `sync`: everything else.

Structural relationships produce no message. `STRUCTURAL_SEMANTICS` (`dependsOn`, `implementedBy`, `implements`)
is in `src/sequence/structural.ts`. Their endpoints can still appear through other connectors.

## Intent Continuation rules

Next moves for a selected node (`src/continuation/`). Connectors a rule adds are inferred from
the matrix; a pairing it does not offer, or marks unusual, is dropped.

- **High confidence** (may ghost unprompted): a `primary` rule whose evidence holds and that
  repeats nothing already drawn.
- **Medium**: shown only when asked with `]` / `[`, or in the picker a connector dropped on empty
  canvas opens.
- **Keyboard only**: the `service-*`, `actor-*`, `person-*` and `component-*` rules
  (`surfaces: 'invoke'`) never appear in that picker or unprompted.

<!-- continuation-rules:start — generated from `src/continuation/rules.ts`; `tests/continuation.test.ts` fails on drift -->
| Rule | Tier | Adds | Reason |
| --- | --- | --- | --- |
| `topic-fan-out-queue` | primary | Queue | This topic has a publisher but no delivery path. |
| `topic-subscriber` | secondary | Queue → Worker | A subscriber: its own queue and the worker consuming it. |
| `topic-fan-out-worker` | secondary | Worker | Subscribers can also receive directly from the topic. |
| `queue-consumer` | primary | Worker | This queue has no consumer. |
| `queue-dead-letter` | secondary | Dead-letter queue | This queue has a consumer but no dead-letter path. |
| `stream-consumer-dead-letter` | secondary | Dead-letter queue | This consumer reads a stream but has nowhere to park a record it cannot process. |
| `gateway-route` | primary | Service | This gateway doesn't route to anything yet. |
| `scheduler-trigger-service` | primary | Service | This scheduler doesn't trigger anything yet. |
| `scheduler-trigger-worker` | secondary | Worker | A scheduled job is usually a Worker. |
| `object-storage-fan-out-queue` | primary | Queue | Uploads here have nowhere to notify yet. |
| `object-storage-fan-out-topic` | secondary | Topic | Multiple subscribers can watch this bucket through a topic instead. |
| `port-implementation-component` | primary | Component | This port isn't implemented by anything yet. |
| `port-implementation-service` | secondary | Service | A port can also be implemented by a whole service. |
| `adapter-port` | secondary | Port | The contract this adapter sits behind. |
| `table-next-stage` | secondary | Table | The next stage of the pipeline this table is part of. |
| `service-data-store` | secondary | Data Store | Services usually own their data. |
| `service-topic` | secondary | Topic | Publish events other parts of the system react to. |
| `service-queue` | secondary | Queue | Hand work off to be processed later. |
| `service-service` | secondary | Service | Call another service. |
| `service-cache` | secondary | Cache | Keep hot reads close. |
| `service-external` | secondary | External System | Call a system outside this one. |
| `service-search-index` | secondary | Search Index | Queries its data store can't answer. |
| `worker-indexes` | secondary | Search Index | This worker doesn't index anything yet. |
| `actor-gateway` | secondary | Gateway | Requests usually enter through a gateway. |
| `actor-api` | secondary | API | Or call an API directly. |
| `person-system` | secondary | System | The system this person uses. |
| `person-external` | secondary | External System | Or a system someone else runs. |
| `component-component` | secondary | Component | The next part of this one — a use case, a domain model, a repository. |
| `component-adapter` | secondary | Adapter | Where this reaches something outside itself. |
| `component-data-store` | secondary | Data Store | What it reads and writes. |
<!-- continuation-rules:end -->

Nothing starts unprompted from a plain Service, an Actor, a Data Store, a Cache, a File System, a
Search Index or a non-Port Component: each has too many valid next moves. Services and Actors get
a short list when asked. A Table gets one only when another store already `ingests` or
`transforms` into it.

### Where it won't guess

For these shapes, `]` opens the add-element picker with a one-line reason
(`src/continuation/ambiguity.ts`). A test fails if asking returns nothing for an unlisted shape.

<!-- continuation-ambiguous:start — generated from `src/continuation/ambiguity.ts`; `tests/continuation.test.ts` fails on drift -->
| Case | Shape | Why there is no suggestion |
| --- | --- | --- |
| `overview` | Infrastructure in a System Context view | This view is a system overview — what comes after this belongs a level down. |
| `table` | Table | A table could be an outbox, a read model or plain business data — nothing here says which. |
| `data-store` | Data Store | What comes after a data store depends on who reads it — a service, a worker or a replica. |
| `cache` | Cache | A cache is usually where a path ends — anything after it is your call. |
| `file-system` | File System | Files here could feed a job, a service or nothing at all. |
| `search-index` | Search Index | A search index is usually where a path ends — anything after it is your call. |
| `dead-letter` | Dead-letter queue | Re-driving dead letters is a choice, not a default — many never leave the queue. |
| `external` | External System | What a system someone else runs talks to is mostly outside this diagram. |
| `component` | Component | A controller, a use case and a repository all look alike — nothing here says which this is. |
<!-- continuation-ambiguous:end -->

### Ranking

Confidence comes first. Within a confidence level, signals in `src/continuation/rank.ts` reorder
(never promote); ties fall back to tier, then the rules table order.

| Signal | Effect |
| --- | --- |
| Sibling branch | A fan-out anchor (Topic, Gateway, Object Storage) with a branch already leads with another of the same shape. |
| Fits the neighborhood | A Service's alternatives are ordered by what points at it (below). |
| Repeats what's there | The same verb to the same kind of node drops back. Fan-out rules are exempt. |
| Already drawn | Connecting to an existing node outranks creating a look-alike. |
| Recently accepted | A small nudge among medium candidates for a rule accepted this session. Never saved. |

#### What points at it

`src/continuation/role.ts` reads a Service's inbound connectors. The most specific row wins.

| What points at it | Leads with |
| --- | --- |
| Queue, Topic, Stream or dead-letter queue | Data Store, Topic, External System |
| Scheduler | Data Store, External System, Search Index |
| Gateway or an Actor | Data Store, Cache, Service |
| Nothing, or another Service | Authored order |

This only reorders; it never adds, removes or surfaces a candidate. **Search Index** is offered to
a Service only once it writes to a Data Store.

### Connecting to what's already there

A candidate may connect to an existing node instead of creating one (`src/continuation/existing.ts`).

- Verbs: `publishes`, `writes`, `readsWrites`, `command`, `fansOut`, `deliversTo`, `consumes`,
  `routes`, `triggers`, and `calls` from an Actor.
- The target must be nearby, in the same boundary, a valid matrix pairing, not connected to the
  anchor either way or two hops away, and not already receiving that verb from someone else.
- In a System Context view, only people and systems qualify.
- It ghosts unprompted only when the target has no inbound connections, the anchor doesn't
  already do the same to the same kind of node, the names share a word or it is the only
  candidate, and the direction is not a coin toss.
- A bucket needs an inbound `writes` or `readsWrites` before a notification path appears
  unprompted.

### Compensation

`compensates` is never inferred (`src/continuation/compensation.ts`).

- A Service that already compensates one step and drives (`command`, `calls`, `http`, `grpc`) two
  or more uncompensated steps offers **Compensate *step*** when asked. With one left, it could be
  the pivot, so nothing is offered.
- Between two services, a second connector becomes the compensation (or the step, if the undo was
  drawn first). A third is refused.
- A step's connector also has **Add compensation** in its inspector, ⌘K and context menu.

### What the view is showing

A canvas or room may store a `ViewLevel` (System context, Containers, Components), set by a
starter or the **View level** command. Levels of nested rooms are derived (`src/depth/level.ts`),
never stored. The status bar and depth map show the level in force.

- `silentAt: ['context']`: every infrastructure rule is quiet in a System Context view, and so are
  existing-node suggestions for infrastructure.
- `levels`: a rule offered only where the level is known (`person-*` at context, `component-*` at
  component).

Continuation is off during a flow lens, presentation or focus mode. Accepting never changes a Flow.
