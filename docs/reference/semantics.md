# Architecture semantics

The contributor-facing reference for what Draft Canvas actually understands about the diagrams you
draw — the concrete rules, not the reasoning behind them (for that, see
[`architecture.md`'s Relationship model](architecture.md#relationship-model)). Everything below
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
| `database` | Database shape, `databaseKind` of `generic`/`sql`/`nosql`/`table` |
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
touches a port stays neutral rather than inheriting verbs a contract can't have. The
implementation can be drawn from either end, because both readings are true: `implemented by` on
the connector *leaving* a port keeps the runtime reading (the port, then what sits behind it);
`implements` on a connector *arriving* at a port from an adapter or a service points the way the
source dependency actually points — the implementer depends on the port's owner, never the other
way round. That second arrow is what the Hexagonal starter draws, so its "dependencies point
inward" is a picture rather than a footnote. Either way a realization wears a hollow arrowhead
(`edges/kindStyle.ts`), the one connector that carries no runtime traffic told apart from the
solid-headed calls beside it.

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
| Database → Service | reads, query, cdc | reads | `cdc` — a worker tailing the database's own change log, not an ordinary query |
| Service → Cache | writes, reads, invalidates, dependsOn | writes | `invalidates` is cache-only |
| Cache → Service | reads | reads | |
| Service → File System | reads, writes, watches, dependsOn | writes | |
| File System → Service | reads | reads | |
| Service → Object Storage | reads, writes, dependsOn | writes | |
| Object Storage → Service | reads | reads | |
| Object Storage → Queue/Topic | publishes, event | publishes | object storage is the one storage kind that legitimately triggers a downstream event |
| Object Storage → Database | transforms, ingests | transforms | a landing zone refined into a structured table |
| Service → Search Index | searches, indexes, dependsOn | searches | |
| Service → Queue | publishes, consumes, command, event, dependsOn | publishes | `consumes` for a worker drawn pulling from its queue — "consumes from" |
| Queue → Service | consumes, deliversTo, event | consumes | competing consumers — reads "consumed by" in this direction |
| Service → Topic | publishes, event, dependsOn | publishes | |
| Topic → Service | deliversTo | deliversTo | a topic pushes to every subscriber; never "consumed by", which is a queue's shape |
| Topic → Queue | fansOut, deliversTo | fansOut | |
| Topic → Search Index | indexes, ingests | indexes | a topic sinking into a search index with no consumer drawn, the same word `Service → Search Index` uses; a Stream is a `queue` and takes the Worker path |
| Topic → Database | ingests | ingests | a warehouse sinking a topic directly; the reverse pairing stays unlisted |
| Queue → Topic | dependsOn, event | *(none)* | **`status: 'unusual'`** — see below |
| Queue → Dead-letter queue | deadLetters | deadLetters | `failure` behaviour and a dashed (`async`) line — the same edge "Add DLQ" generates; `deliveryAttempts` captions it "after N attempts" |
| Service → Dead-letter queue | deadLetters, publishes | deadLetters | a consumer parking a message it gave up on itself; the same dashed `failure` path as the broker's own |
| Topic → Dead-letter queue | dependsOn | *(none)* | **`status: 'unusual'`** — a topic never dead-letters; retries and a DLQ belong to each consumer's own queue |
| Service → Service | calls, http, grpc, command, query, event, compensates, dependsOn | calls | the one pairing with a full sync/async/callback/conditional/retry/failure/fallback picker |
| Service → External | same as Service → Service | calls | `external` is a flavour of `service` for any pairing without its own row |
| Component → Component | uses, dependsOn, calls | uses | an in-process dependency, never a network call; checked before the `service` fold |
| Service → Port | calls, implements, dependsOn | calls | `implements` when the service is what stands behind the port, not what drives it |
| Component → Port | uses, calls, implements, dependsOn | uses | an adapter may drive a port (`calls`) or implement it (`implements`); only the author knows which, so neither is the default |
| Port → Component / Service | implementedBy | implementedBy | the same realization read from the port's end: the thing after the port depends on the port's owner |
| Port → Database | dependsOn | *(none)* | **`status: 'unusual'`** — a port is a contract; something implements it and talks to the store |
| Actor → Service | calls, http, command, query | calls | synchronous by predetermination, no behaviour picker |
| Database → Database | ingests, replicates, cdc, syncs, transforms | ingests | data movement, not a request/response shape; `transforms` when the data's shape genuinely changes |

A category without its own row borrows one, most specific first: the exact pair, then the source
folded (a Worker as a Service), then the target folded, then both. That is how Worker → Dead-letter
queue finds its own row instead of plain Service → Queue, and Gateway → Worker routes. A
dead-letter queue only folds with both sides at once, so DLQ → DLQ stays unlisted.

`dependsOn` is only offered where the source can depend on something — never from a store, a
channel or a port, where "depends on" would read backwards. The three `unusual` rows keep it as
their one neutral choice.

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

## Captions read in the arrow's direction

A connector's caption reads *source, verb, target*, so the words always agree with the arrow. A
relationship keeps one meaning however it is drawn — `reads` is always "a service reads a store" —
and when the arrow starts at the verb's object, the caption turns passive
(`src/document/edgeSemantics.ts`'s `relationLabel`):

| Relationship | Arrow from the doer | Arrow from the other end |
| --- | --- | --- |
| reads / writes / queries / searches / invalidates / watches | Service → Database: "reads from" | Database → Service: "read by" |
| consumes | Worker → Queue: "consumes from" | Queue → Worker: "consumed by" |
| ingests / indexes | — | Topic → Database: "ingested by", Topic → Search Index: "indexed by" |

Verbs a store or channel performs itself — delivers to, fans out to, dead-letters to, publishes to
(object storage), replicates to, syncs to, CDC, transforms — have no passive form; they already
read in the arrow's direction. The wording is display only: `semantic` is never rewritten, so
diagrams saved before this read correctly without being touched, and reversing a connector keeps
an explicit relationship's meaning while its caption turns around. An inferred one is re-inferred
for the new direction instead (Service → Queue "publishes to" reversed is Queue → Service
"consumed by"), and loses a dashed line only inference gave it.

Choosing a relationship never writes its words into the connector's label: the label is only ever
what someone typed, and it always wins over the caption.

**Queue, Topic and Stream stay distinct where it matters.** A Queue is *consumed by* competing
consumers; a Topic *delivers to* every subscriber and *fans out to* their queues; a dead-letter
path is its own dashed failure route. A Stream shares a Queue's words — publish, then consume —
because the vendor-neutral verbs are the same; nothing here assumes a particular broker.

**Ports and adapters stay neutral.** A fresh Adapter → Port connector infers the neutral "uses" and
Port → Core or Adapter "implemented by"; "implements" (Adapter → Port, the dependency direction) is
one pick away. The diagram can't tell a driving port from a driven one, so neither is guessed.

### Review notes

Every row was checked for the same things: the relationship is technically real, the caption agrees
with the arrow, dependency isn't confused with runtime traffic, nothing is assumed synchronous or
vendor-specific, and a legitimate design that ignores the suggestion is still drawable. The
judgement calls that remain on purpose:

| Row | Why it stays |
| --- | --- |
| Service → Database / Cache default "writes to" | Chosen by the user over a neutral default. Reversing the arrow gives "read by". |
| Service → Service "calls" | No behaviour is assumed: sync, async, retry and the rest stay one pick away. |
| Scheduler → Service / Worker "triggers" | Says nothing about how, so it doesn't pretend a scheduler makes a synchronous call. |
| Service → Table "writes to" | A Table folds into Data Store; the caption names data access, not a network hop. |
| Database → Queue, Queue → Queue, Actor → Database | Unlisted on purpose: CDC, bridges and odd shapes are all real, and no opinion beats a wrong one. |
| The three `unusual` rows | Still offer "depends on" as their one neutral pick; the ▲ marker already says to look again. |

## Two independent vocabularies

- **`EdgeSemantic`** — what the connection *represents*: `http`, `grpc`, `event`, `command`,
  `query`, `reads`, `writes`, `publishes`, `consumes`, `calls`, `dependsOn`, `fansOut`,
  `deliversTo`, `ingests`, `replicates`, `cdc`, `syncs`, `deadLetters`, `invalidates`, `watches`,
  `searches`, `indexes`, `routes`, `triggers`, `uses`, `implementedBy`, `compensates`,
  `transforms`. A label convenience only — never changes the connector's colour.
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

The Sequence Diagram (`src/sequence/`, see `architecture.md`) applies the same principle one
level up: a Junction is never a lifeline. `resolveJunctionEndpoint` (`connectorSemantics.ts`) is
`resolveTransparentCategory`'s node-identity sibling — same "walk the whole graph, not just the
current selection" traversal, but resolving to an actual node rather than a category, since a
sequence message needs a real participant to point at, not just a category label. A `Service A →
Junction → Service B` path flattens to one message between A and B; only when the Junction's side
is genuinely ambiguous (two different real nodes feeding it) or dangling (nothing feeding it) does
the Junction itself stand in as the participant — the same "no opinion beats a wrong one" instinct
as an unlisted matrix pairing, applied to identity instead of category.

## Sequence Diagram interaction kinds

A third, small vocabulary — derived, not stored on the document — buckets every Sequence Diagram
message into exactly one of `sync`, `async`, or `response` (`src/sequence/label.ts`'s
`InteractionKind`): the synthesized reply to a `hasResponse` edge is always `response`; a request
edge is `async` when its `semantic` is one of the inherently asynchronous relations (`publishes`,
`consumes`, `deliversTo`, `fansOut`, `deadLetters`), or its `kind` is `'event'`/`'async'`, or its
own `async` flag is set; everything else is `sync`. This reads the two existing, independent
vocabularies (`EdgeSemantic`, `ConnectorKind`) plus `hasResponse` — it adds no new field to
`DraftEdge` and no new inference rule to the capability matrix.

A connector's `semantic` can also be purely **structural** — a static architectural fact rather
than something that happens at a point in time during a Flow. `src/sequence/structural.ts`'s
`STRUCTURAL_SEMANTICS` (`dependsOn`, `implementedBy`) is checked before a Flow step's edge is ever
turned into a message: a structural edge contributes no message at all (though its endpoints may
still appear as participants via some *other*, behavioral edge). Deliberately small — every other
`EdgeSemantic`, including `uses` (Component ↔ Component) and `compensates` (Saga),
describes a real runtime interaction and is never excluded.

## Intent Continuation rules

The next moves Draft Canvas will sketch for a selected node (see
[`architecture.md`'s Intent Continuation](architecture.md#derived-capabilities)). Every
connector a rule adds is inferred from the capability matrix above — a rule that proposed a pairing
the matrix does not offer, or flags `unusual`, is dropped by the engine before it can show.

A rule adds one node or a short chain (`Queue → Worker`). Each candidate gets a **confidence**,
derived rather than authored: **high** only for a `primary` rule whose evidence holds in this exact
neighborhood and which repeats nothing already drawn — the one kind of suggestion that may appear
unprompted as a ghost. Everything else is **medium**: listed when asked — `]` / `[` on the canvas,
or the picker a connector dropped on empty canvas opens. Rules marked "keyboard only" below never
appear in that picker, whose standing presets already cover those shapes.

<!-- continuation-rules:start — generated from `src/continuation/rules.ts`; `tests/continuation.test.ts` fails on drift -->
| Rule | Tier | Adds | Reason |
| --- | --- | --- | --- |
| `topic-fan-out-queue` | primary | Queue | This topic has a publisher but no delivery path. |
| `topic-subscriber` | secondary | Queue → Worker | A subscriber: its own queue and the worker consuming it. |
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

Keyboard only: the `service-*` and `actor-*` rules.

Nothing starts unprompted from a plain Service, an Actor, a Data Store, a Cache, a File System, a
Search Index or a bare (non-Port) Component: each has too many valid next moves for any one of them
to be *the* move, and no suggestion beats a weak one. Services and Actors get a short list when
asked; a Table gets one only once the graph shows it is a pipeline stage (another store already
`ingests` into or `transforms` into it, as in the Medallion starter); the rest get no suggestion —
asking opens the picker instead (below). What a Service's list *leads* with is not fixed, though —
see "What points at it" below. Adding a rule for one category is never license to assume a
neighboring one is now covered too — see `tests/continuation.test.ts`'s broad silence sweep.

### Where it won't guess

Some shapes have several equally valid next moves and nothing in the diagram picks between them.
The engine stays silent on those — a wrong suggestion costs more than none — but the person who
pressed `]` still gets an answer: the add-element picker opens beside the shape, with one line
saying why there is no suggestion. Choosing from it adds and connects the shape like a dropped
connector would. Each case is written down in `src/continuation/ambiguity.ts`, and a test fails if
asking ever comes back empty for a shape that isn't listed:

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

**The Outbox is the case in point.** In the Transactional Outbox starter, the Outbox and the
Business Data beside it are the same `table` Data Store, in the same boundary, written by the same
service — only their labels differ, and no rule reads labels. So neither gets an "outbox relay"
Worker suggested: offering one for any Table a service writes would be wrong more often than right.
A case leaves this list only when the document gains a real signal that tells its readings apart —
for a Table, something like a role on the Data Store, the way `deliveryRole` tells a dead-letter
queue from a queue. That signal doesn't exist yet, so the Table stays here.

### Ranking

Confidence always comes first. Among candidates of the same confidence, a few named signals
(`src/continuation/rank.ts`) reorder — never promote — and ties fall back to tier, then the table's
order:

| Signal | Effect |
| --- | --- |
| Sibling branch | A fan-out anchor (Topic, Gateway, Object Storage) that already has a branch of the same shape ranks another one first — a Topic with a `Queue → Worker` subscriber leads with `Queue → Worker`. |
| Fits the neighborhood | A Service is the shape whose next move least follows from the shape itself, so its own alternatives are ordered by what points at it. Never overrides the row below. |
| Repeats what's there | The same verb to the same kind of node the anchor already has drops back: a Queue with a consumer leads with its dead-letter queue, a Service writing to a Data Store gets another Data Store last (a Cache is unaffected). Fan-out rules are exempt. |
| Already drawn | Connecting to an existing node outranks creating a look-alike. |
| Recently accepted | A rule accepted earlier in this session gets a small nudge among medium candidates. Session-only, never saved. |

#### What points at it

Nothing on a Service box says whether it answers requests, drains a queue or wakes on a timer, and
the next thing you would draw is different in each. Its inbound connectors do say, so the list `]`
cycles through is ordered by them (`src/continuation/role.ts`):

| What points at it | Reading | Leads with |
| --- | --- | --- |
| A Queue, a Topic or a dead-letter queue | Work arrives here | Data Store, then Topic, then External System |
| A Scheduler | A job on a timer | Data Store, then External System |
| A Gateway or a person | Someone is waiting for an answer | Data Store, then Cache, then Service |
| Nothing, or another Service | Not enough to say | The authored order, unchanged |

The most specific reading wins: a consumer that also sits behind a gateway is still a consumer.
This reorders a Service's own alternatives and does nothing else — it never adds a candidate, never
takes one away, never makes one appear unprompted, and never argues a shape back up that the anchor
already draws. Being wrong about a role costs one more press of `]`.

One row has to be earned rather than ranked: a **Search Index** is offered only once the Service
already writes to a Data Store, because `searches` means "the queries that store can't answer" and
an index in front of nothing has no content. A Worker keeps its own `worker-indexes` row instead,
so the same shape is never listed twice.

### Connecting to what's already there

Before drawing something new, the engine looks for a node already on the canvas that finishes the
sentence — "Order Service *publishes* Order Events", the topic right next to it. Only these verbs
qualify: publishes, writes, fans out, delivers to, consumes, routes, triggers, and calls from an
Actor. A candidate must be nearby, in the same boundary, not already connected either way, not two
hops upstream (no loops), and not already receiving that verb from someone else.

It ghosts unprompted only when the target has no connections coming in, the anchor doesn't
already do the same thing to the same kind of node, the names share a word ("Payment Service" /
"Payments DB") or it is the only such node around, and the direction is not a coin toss. Two loose
shapes that could each continue into the other — a Service and a Topic side by side — stay quiet
until one of them is connected. The ghost is only the connector plus an outline on the target;
nothing is duplicated.

### Compensation

`compensates` is never inferred — no pairing defaults to it — so one only exists because someone
drew it, and that makes it the one pattern continuation recognises by name
(`src/continuation/compensation.ts`). A Service that already compensates at least one step, and
drives (`command`, `calls`, `http`, `grpc`) **two or more** steps it doesn't compensate yet, offers
**Compensate *step*** for each of them when asked: a `compensates` connector to the step already
drawn. Two, because a saga's last forward step — its pivot — legitimately has no undo; with one step
left there's no telling a pivot from a gap, so a finished saga like the Saga starter's says nothing.
Keyboard only, never unprompted, and only where the matrix offers `compensates` (Service to Service
or External System). The connector is written as your own choice would be, so changing a node's
kind never re-infers it back to `calls`.

Drawing one by hand works the same way. Two services can have **one** second connector between
them — a step and its undo — and nothing more: dragging another arrow onto a service already
called draws it as `compensates` (or, the other way round, as the step beside an undo drawn first),
and a third is refused, as any second arrow is between other shapes. A step's connector also has
**Add compensation** in its inspector, ⌘K and right-click menu, and **Compensates** is on its
Interaction menu.

### What the view is showing

A canvas — or one room inside it — may say what it shows: **System context**, **Containers** or
**Components** (`ViewLevel`). It is stored only when someone actually said so, from a starter that
declares one or the "View level" command; what the rooms *inside* it show follows from that and is
never written down (`src/depth/level.ts`). Most canvases say nothing, and behave exactly as they
always have.

A rule can care about the level in two ways, and the asymmetry is the policy:

- **`silentAt`** — quiet at an altitude where it would be noise, unchanged everywhere else,
  *including* where nothing is known. Every infrastructure rule above is `silentAt: ['context']`: a
  dead-letter queue has no business in a diagram of systems and the people who use them.
- **`levels`** — offered only where the level is known to be one of them, for a rule that makes
  sense at one altitude and nowhere else (`person-system`, `component-*`).

So a level someone chose can take a suggestion away, and only a level someone chose can introduce
one — nothing ever changes on a guess. Where a level is in force, it is on screen: the status bar
names it, and the depth map's corner repeats it.

Not yet: continuation does not read the active Flow (the flow lens turns it off) or which starter a
diagram came from (documents don't record it) — which is also why a Table's role can't be read off
the Transactional Outbox starter it came from. Accepting never changes a Flow.
