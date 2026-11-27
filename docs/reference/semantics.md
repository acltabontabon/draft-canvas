# Architecture semantics

How Draft Canvas reads a connection: the relation it infers, how its caption reads, what a sequence
derives, and which next shape it suggests. For the reasoning, see
[Architecture](architecture.md#relationship-model).

A connection is never rejected. A new connector gets an inferred default, and an unusual pairing
gets a guidance note.

## Node categories

`categoryOf` (`src/document/connectorSemantics.ts`) maps each node to the category the matrix is
keyed by:

| Category | Derived from |
| --- | --- |
| `actor` | Actor shape |
| `agent` / `device` | Actor with that `actorKind` |
| `service` | Service shape, `serviceKind` of `generic` or `api` |
| `external` / `worker` / `scheduler` / `gateway` | Service with that `serviceKind` |
| `loadBalancer` / `proxy` | Service with `serviceKind` `load-balancer` or `proxy` |
| `component` | Component shape, `componentKind` of `generic`, `module` or `adapter` |
| `port` | Component with `componentKind: 'port'` |
| `database` | Database shape, `databaseKind` of `generic`, `sql`, `nosql` or `table` |
| `cache` / `fileSystem` / `objectStorage` / `searchIndex` | Database with `databaseKind` `cache`, `file-system`, `object-storage`, `search-index` |
| `queue` / `topic` / `stream` | Queue shape with that `queueKind` |
| `deadLetter` | Queue with `deliveryRole: 'dead-letter'` (what **Add DLQ** creates) |
| `artifact` | Artifact shape, `artifactKind: 'file'` |
| `config` / `secret` / `certificate` | Artifact with that `artifactKind` |
| `junction` | Junction (ellipse) shape |
| `generic` | Every other shape (text, note, code, group): no rules apply |

A pairing without its own row borrows one (`capabilityFor`):

- `loadBalancer` and `proxy` read as `gateway`, and `config`, `secret` and `certificate` as
  `artifact` (`baseCategory`); only their captions differ.
- `external`, `worker`, `scheduler`, `gateway` and `component` fold to `service`; `agent` and
  `device` to `actor`; `stream` to `topic`; `deadLetter` to `queue`. `artifact` and `port` never
  fold.
- Lookup order: exact pair, source folded, target folded, both folded. A dead-letter source folds
  only when both sides do, so DLQ → DLQ stays unlisted.

## The capability matrix

`MATRIX` in `src/document/connectorSemantics.ts` is the source of truth, keyed `source>target`. It
is sparse on purpose: a pairing with no entry (Queue → Queue, Actor → Database, anything touching
`generic`) is an unrestricted connector with no default.

| Source → Target | Relations offered | Default | Notes |
| --- | --- | --- | --- |
| Service → Database | readsWrites, writes, reads, query, dependsOn | readsWrites |  |
| Database → Service | reads, query, cdc | reads |  |
| Service → Cache | reads, writes, readsWrites, invalidates, dependsOn | reads |  |
| Cache → Service | reads | reads |  |
| Service → File System | reads, writes, readsWrites, watches, dependsOn | writes |  |
| File System → Service | reads | reads |  |
| Service → Artifact | reads, writes, watches, uses, dependsOn | reads |  |
| Artifact → Service | reads, dependsOn | reads |  |
| Actor → Artifact | writes, reads, uses | *(none)* |  |
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
| Service → Dead-letter queue | publishes, deadLetters | publishes | `failure`, dashed; dead-lettering is the queue's redrive, so only a stream consumer's route takes `deadLetters` |
| Topic → Dead-letter queue | dependsOn | *(none)* | unusual |
| Stream → Dead-letter queue | dependsOn | *(none)* | unusual |
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
| Proxy → Object Storage | reads, dependsOn | reads | a CDN's origin; captioned "serves from". A Gateway or Load Balancer here keeps the nudge |
| Proxy → File System | reads, dependsOn | reads | a web server's files; captioned "serves from" |

- Relations offered are suggestions; the inspector keeps a connector's current value selectable.
- **Insert Worker** splices a Service between the Queue and Topic and re-infers both connectors.
- "Dashed" rows set `defaultAsync`.
- A technology can refine a default: a database drawn into a change-data-capture tool infers `cdc`
  instead of `reads`.
- Reconnecting, reversing, or changing a node's kind or technology re-infers only inferred
  relationships, and drops only a dash that inference added. Explicit choices are kept.

## Captions read in the arrow's direction

A caption reads *source, verb, target*. When the arrow starts at the verb's object, the caption
turns passive (`relationLabel` in `src/document/edgeSemantics.ts`): Database → Service reads "read
by", Queue → Worker "consumed by". Captions are display only: `semantic` is never rewritten, and a
typed label always wins. Sequence export sends a passive connector from its far end with the active
caption (`Worker ->> Queue: consumes from`).

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
`Service → Junction → Database` still infers `readsWrites`. A side with no single category resolves
to `junction`, with the unrestricted vocabulary. Sequence export flattens `A → Junction → B` into one
message (`resolveJunctionEndpoint`); the Junction is a participant only when its side is ambiguous
or dangling.

A link between Junctions (`DraftNode.link`) is not a connector and is never looked through: nothing
is inferred across it, no flow steps over it, an outage walk stops at each Junction, and sequence
export treats the two as separate dangling Junctions.

## Sequence diagram interaction kinds

Each sequence-diagram message is `sync`, `async` or `response`, derived from its connector
(`InteractionKind` in `src/sequence/label.ts`); nothing new is stored on the document. Structural
relationships produce no message. `STRUCTURAL_SEMANTICS` (`dependsOn`, `implementedBy`,
`implements`) is in `src/sequence/structural.ts`. Their endpoints can still appear through other
connectors.

## Native sequences

A [sequence](../guides/sequence-diagrams.md) stores what happens, never where it is drawn
(`src/document/sequenceModel.ts`).

- Work bars are derived from the messages' `activate`, `deactivate` and `replyTo`
  (`src/sequence/executions.ts`).
- Defaults are written when a message is made, then left alone: a call between two participants
  starts work, and a reply ends it. A reply is never inserted.
- Kind is suggested, never assumed (`src/sequence/suggest.ts`). Where the matrix says a pairing is
  normally asynchronous, **Asynchronous** is marked as suggested. Choosing a kind stamps
  `kindOrigin: 'explicit'` and ends the suggestion.
- When the participants' pairing is known, a new message's label is the matching connector caption.
  Replies, self-messages and lifecycle messages start blank.
- Checks (`src/sequence/check.ts`) only report problems and never change anything. A move that
  would cause one is refused.
- A linked participant and its shape are one identity: name, kind, technology and colour
  (`src/document/sequenceLinks.ts`). A change at either end updates the other in the same undo
  step; if both changed, the shape wins.
- Order is never inferred from connectors or layout. A sequence made from selected shapes has no
  messages; one made from a flow takes the flow's order.

## Next-shape suggestion rules

Next-shape suggestions (**Settings → Canvas**; continuations in the code, `src/continuation/`) offer
what usually comes after the selected node. A rule's connectors are inferred from the matrix; a
pairing the matrix does not offer, or marks unusual, is dropped.

- High-confidence suggestions may ghost unprompted: a `primary` rule whose evidence holds and that
  repeats nothing already drawn.
- Medium ones show only when asked with `]` / `[`, or in the picker a connector dropped on empty
  canvas opens.
- The `service-*`, `actor-*`, `person-*` and `component-*` rules (`surfaces: 'invoke'`) appear only
  when asked from the keyboard.

The Reason column is each suggestion's tooltip and screen-reader text.

<!-- continuation-rules:start — generated from `src/continuation/rules.ts`; `tests/continuation.test.ts` fails on drift -->
| Rule | Tier | Adds | Reason |
| --- | --- | --- | --- |
| `topic-fan-out-queue` | primary | Queue | This topic has a publisher but no delivery path. |
| `topic-subscriber` | secondary | Queue → Worker | A subscriber: its own queue and the worker consuming it. |
| `topic-fan-out-worker` | secondary | Worker | Subscribers can also receive directly from the topic. |
| `queue-consumer` | primary | Worker | This queue has no consumer. |
| `queue-dead-letter` | secondary | Dead-Letter Queue | This queue has a consumer but no dead-letter path. |
| `stream-consumer-dead-letter` | secondary | Dead-Letter Queue | This consumer reads a stream but has nowhere to park a record it cannot process. |
| `gateway-route` | primary | API | This gateway doesn’t route to anything yet. |
| `scheduler-trigger-worker` | primary | Worker | This scheduler doesn’t trigger anything yet. |
| `scheduler-trigger-service` | secondary | Service | Or a service, for work that is more than a job. |
| `object-storage-fan-out-queue` | primary | Queue | Uploads here have nowhere to notify yet. |
| `object-storage-fan-out-topic` | secondary | Topic | Multiple subscribers can watch this bucket through a topic instead. |
| `port-implementation-component` | primary | Component | This port isn’t implemented by anything yet. |
| `port-implementation-service` | secondary | Service | A port can also be implemented by a whole service. |
| `adapter-port` | secondary | Port | The contract this adapter sits behind. |
| `table-next-stage` | secondary | Table | The next stage of the pipeline this table is part of. |
| `service-data-store` | secondary | Data Store | Services usually own their data. |
| `service-topic` | secondary | Topic | Publish events other parts of the system react to. |
| `service-queue` | secondary | Queue | Hand work off to be processed later. |
| `service-service` | secondary | Service | Call another service. |
| `service-cache` | secondary | Cache | Keep hot reads close. |
| `service-external` | secondary | External System | Call a system outside this one. |
| `service-search-index` | secondary | Search Index | Queries its data store can’t answer. |
| `worker-indexes` | secondary | Search Index | This worker doesn’t index anything yet. |
| `actor-gateway` | secondary | Gateway | Requests usually enter through a gateway. |
| `actor-api` | secondary | API | Or call an API directly. |
| `actor-web-app` | secondary | Web App | Or the app they use, which then calls the system. |
| `person-system` | secondary | System | The system this person uses. |
| `person-external` | secondary | External System | Or a system someone else runs. |
| `component-component` | secondary | Component | The next part of this one — a use case, a domain model, a repository. |
| `component-adapter` | secondary | Adapter | Where this reaches something outside itself. |
| `component-data-store` | secondary | Data Store | What it reads and writes. |
<!-- continuation-rules:end -->

Nothing starts unprompted from a plain Service, an Actor, a Data Store, a Cache, a File System, a
Search Index or a non-Port Component: each has too many valid next shapes. Services and Actors get
a short list when asked. A Table gets one only when another store already `ingests` or `transforms`
into it.

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
| `dead-letter` | Dead-Letter Queue | Re-driving dead letters is a choice, not a default — many never leave the queue. |
| `external` | External System | What a system someone else runs talks to is mostly outside this diagram. |
| `component` | Component | A controller, a use case and a repository all look alike — nothing here says which this is. |
<!-- continuation-ambiguous:end -->

### Rules every suggestion keeps

- Ranking (`rank.ts`, `role.ts`) only reorders candidates within a confidence level: it never
  promotes, adds, removes or surfaces one. A rule accepted this session gets a small nudge that is
  never saved.
- A suggestion never lands on an existing shape. With no clear place, there is no suggestion.
- A candidate may connect to an existing node instead of creating one (`existing.ts`): a nearby node
  in the same boundary, with a valid pairing, that is not already connected to the anchor.
- `compensates` is never inferred (`compensation.ts`). **Compensate *step*** is offered only when
  asked. Between two services, a second connector becomes the compensation and a third is refused.
- A view's level (`ViewLevel`, set by a starter, the **View level** command or an answer to the
  system-overview question) only narrows suggestions. Infrastructure rules are silent in a System
  Context view (`silentAt`); `person-*` rules appear only at context level and `component-*` rules
  only at component level (`levels`). A room without a level of its own derives one
  (`src/depth/level.ts`).
- Suggestions are off during a flow lens, presentation, focus mode and an outage walk; during a
  gesture or while the Pencil is in hand; and while a dropped connector's picker is open. Nothing is
  suggested that would take the file past its [size limits](schema.md#limits), and accepting one
  never changes a Flow.
