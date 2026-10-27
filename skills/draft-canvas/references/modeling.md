# Modeling a repository

How to turn what you read into a diagram that is true and reads at a glance. The app lays it out;
these choices are what decide whether the layout *can* be clean.

## Pick the views

Count what belongs to the system: each separately running thing — web app, API, worker, scheduler —
plus the stores, queues and topics it owns (each queue counts: it is an element in the view). Then:

| The repository is | Top view | One level down | Two levels down |
| --- | --- | --- | --- |
| One deployable (a single API, a CLI, a mobile app) | `container`: the service, its stores and queues, the people and externals around it | its components | — |
| A system of up to ~8 containers | `container`: people, a `kind: "system"` group with the containers, externals outside | components of the 1–3 containers with real logic | — |
| A system of more than ~8 containers | `context`: people, the system as one `service`, externals | the system's containers (no group needed: the view *is* the system) | components of the 1–3 key containers |
| Several systems in one monorepo | `context`: one `service` per system, people, shared externals | each system's containers | key components |

The ~8 counts what the system runs and owns; a view's ~15 counts every element in it, people and
externals drawn again included. Draft Canvas advises splitting a boundary that holds more than 8
elements, and a view past ~15 elements reads poorly; these thresholds keep you under both. Rooms nest
at most three deep.

**Which containers get a component view.** The one that holds the main request path's logic always
does: it orchestrates calls to the others, owns the business rules, or is a codebase with modules of
its own (an API with controllers, services and repositories). Add up to two more on the same test. A
container that only forwards a call, wraps one library or serves one endpoint does not — its
description says enough. Draw its 5–10 parts, the containers and externals it calls again around them,
and the main request through them as that view's first flow.

A context view earns its place with what surrounds the system: people in different roles, external
systems. When there is nothing around it but one kind of user, a context view is two boxes and an
arrow — open on the container view instead, **without** a system group (a boundary only separates
the system from what is outside it; with nothing outside, it adds a box and an advisory). Up to 15
elements read fine that way.

A group is declared once and named by each member:

```json
"groups": [{ "id": "platform", "label": "Storefront Platform", "kind": "system" }],
"nodes": [{ "id": "orders", "type": "api", "label": "Orders API", "group": "platform" }]
```

`kind`: `system` (a C4 software system), `domain` (a bounded context), `network`, `deployment`, or
`group`/`boundary` (purely visual). `parent` nests one group in another.

In a view one level down, draw the people and external systems the containers talk to *again*, as
their own elements with their own ids (`c.shopper`, `c.stripe`): a view only connects what is in it,
and ids are unique across the whole file.

## What is an element

- **Containers:** anything that runs or stores on its own — a deployable, a database, a queue, a
  bucket. A Go module with five `cmd/*` programs is five containers; a monorepo package imported by
  others is not a container (it is a component of each, or nothing).
- **Components:** a container's controllers/routes, use cases or services, domain modules, adapters
  to infrastructure. 5–10 per inside view; fold small helpers into the component that owns them.
- **Leave out:** CI, test infrastructure, linters, local dev tools (Adminer, Mailpit, LocalStack),
  logging/metrics/tracing backends, feature-flag SDKs. If one matters for understanding, it is a note.
- **External systems:** one element per provider the code calls (Stripe, SendGrid, the partner API),
  never grouped together "to tidy them" — ungrouped, each one sits next to its caller.
- **Stores:** one element per database, not per table (unless tables are the subject — then `table`).
  One element per role a Redis plays (cache vs. queue broker). **But** when each service owns its own
  schema or tables in one server (database-per-service on a shared instance), draw one store per
  owner — "Orders schema", "Kitchen schema" — each next to its service. One store written by every
  service becomes a hub that every line has to cross the diagram to reach; on a real repository this
  took the container view from five crossings to one. Say in a note that they share one server.

## Make the layout's job easy

- **Reading order.** List elements in the order a request meets them: the person or client first,
  then the entry container, then what it calls, then stores and externals. Relationships the same
  way. Ties in the layout are broken by input order.
- **One main path.** Name it as the main flow and pass it as `layout.primaryFlow` (top view). Side
  paths — retries, dead letters, compensations — then bend around it instead of the other way round.
- **Pipelines in data direction.** A poller, a CDC reader or a relay that *reads from* a store is
  clearer drawn store → reader ("Unsent outbox rows", `semantic: "reads"`) than reader → store: the
  pipeline then runs in one line (writer → store → reader → topic) instead of looping back.
- **Replies are implied.** Don't draw a relationship back for a response; use `response` on the
  call. Draw a reverse relationship only for its own interaction (a webhook, a callback, a
  notification).
- **Report-back loops are real; keep them, and give them their own flow.** Workers that report
  progress back to the service that dispatched them (through a "status" or "updates" queue) form a
  cycle: its return line has to run against the reading direction around everything between. That is
  the honest picture. Put the dispatch in the main flow and the report-back in a second flow ("A
  station reports an item ready") rather than re-arranging until the line disappears — no arrange can
  remove a cycle.
- **Fans bundle.** Two or more relationships leaving (or reaching) one element from the same side,
  with the same `semantic` and `kind`, are drawn as one trunk with branches. Give genuinely different
  paths different meanings.
- **Direction.** Leave `layout.direction` out; both are tried and the clearer one kept.
- **Boundaries only when real:** the system, a bounded context/domain, a deployment or network zone.

## Flows

A flow is the presentation: each step plays one relationship with its caption.

- **Order comes from code.** Follow the entry handler's calls in order. Where work forks
  (publish → two consumers), list one branch fully, then the other; the checker accepts a step that
  starts anywhere the story has already been. A relationship is a step at most once per flow, but may
  appear in several flows.
- **A call made twice** over one relationship (get the cart, later empty it; quote shipping, later
  ship): step the relationship at the first call, and light it again at the second with
  `{spotlight: ["<relationship id>"], caption: "Empties the cart."}`. Don't draw a second
  relationship for it — one per direction — and don't fold both calls into one caption.
- **Open with a spotlight:** `{spotlight: [ids], caption}` framing the actors and the entry point —
  including where the first step starts — one sentence on what this flow shows.
- **Caption every step** with what happens there in this request, present tense, ≤ 80 characters:
  "Order and outbox row commit in one transaction." Not the relationship's label again.
- **`highlight`** lights extra elements with a step (the cache consulted, the boundary entered).
- **Failure paths are variants:** `variantOf` the main flow (in the same view), its own colour
  (`rose`, `amber`), only for a path the code takes on purpose: a retry policy, a DLQ, a compensation,
  a circuit-breaker fallback, or a rejection the caller turns into its own outcome (a declined card
  shown as an error page), or an error deliberately swallowed so the request still succeeds (a
  confirmation email that fails without failing the order). An error that is only returned up the
  stack is a sentence in a step's caption, not a variant. Start the variant at the step where the paths
  part — the same relationship as in the main flow, which is where presenting lands when the presenter
  switches with `Shift+F` — with an opening spotlight before it; there is no need to repeat everything
  earlier. End on a `{spotlight: [ids], caption}` of where it lands ("The shopper sees the payment
  error.") — never step a relationship backwards to show the reply.
- **Each view's main flow comes first in that view's flows.** The top view's is also
  `layout.primaryFlow`; an inside view is laid out around its first flow when it is created. Under a
  context view the main request path is the container view's first flow, and a component view's first
  flow is the same request one level down. If an inside view still comes out bent, see the playbook's
  [straightening an inside view](mcp-playbook.md#straighten-an-inside-view).
- At a context level, a short "at a glance" flow (person → system → providers) is the top view's
  `primaryFlow` and gives the presentation an opening before the presenter steps inside (`⌘↓`).

## Notes and code

Three to eight for the whole diagram; each earns its place.

| kind | Use for | Example |
| --- | --- | --- |
| `decision` | A choice the code or an ADR makes, with its reason | "Transactional outbox: the order and its event commit together." |
| `warning` | A risk visible in the code | "Prices stay cached for ten minutes; a change can show stale that long." |
| `question` | What the code can't tell you | "Is an email for a declined card intended?" |
| `note` | Context a reader needs | "Five deployables, one database, one Kafka topic." |
| `code` | A snippet that explains more than a sentence | an event payload, a route signature, the retry policy |

- `about` an element or relationship **attaches** the note to it (a chip that opens on click, moves
  and exports with it). `about` a group places it in the boundary. `attach: false` puts a free card
  beside the element — only for a callout meant to be read without clicking.
- Code snippets: ≤ 15 lines, the lines that matter, real code (trimmed, never invented), with
  `language` — one of `java`, `javascript`, `typescript`, `json`, `yaml`, `xml`, `sql`, `bash`, `http`,
  `log`, `diff` or `plaintext`. Go, Python, Rust, C#, Ruby and the rest go in as `plaintext` (indentation is
  kept). Good candidates: the idempotency key on a payment call, the event schema, the consumer's
  retry/backoff config, the SQL of an important query.
- Mark inferences: "Inferred from the retry config; not verified at runtime."

## Evidence

Every element and the main relationships carry `evidence`: `path` (repository-relative), `basis`
(`observed` when you read it, `inferred` when you concluded it), and as precise a pointer as you have —
`symbol`, `line`, optionally `commit` (the survey prints the short HEAD). It shows in the element's
**Details** as **Source evidence**. Never invent a path or line; `check_diagram.py --repo` verifies them.

## Ids

Short, readable and stable — `orders`, `orders.db`, `c.stripe`, `r-place-order` — because every
later update, note and flow step refers to them, and a refresh keeps them. Letters, digits, `_ . -`,
starting with a letter, unique across the whole file.

## Surveying without the script

When `python3` isn't available, collect the same facts by hand, cheapest first:

1. `README`, `ARCHITECTURE.md`, `docs/adr/` — what the system is and the decisions already written.
2. `docker-compose*.yml`, `k8s/`/`helm/`/`kustomize/`, `*.tf`, `serverless.yml` — the runtime topology:
   services, images, `depends_on`, environment variable *names* (`CART_SERVICE_ADDR` in the
   frontend means frontend → cart).
3. Every manifest (`package.json`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`, `*.csproj`,
   `Cargo.toml`, `Gemfile`) — one deployable each, its framework, and its drivers/SDKs (`pg`, `kafkajs`,
   `stripe`) for stores, brokers and providers.
4. Entry points (`main.*`, `server.*`, `cmd/*/main.go`, `Program.cs`, `*Application.java`) and route
   registrations — the API surface.
5. Publishers and consumers (search for `publish`, `subscribe`, `@KafkaListener`, `QueueName(`,
   `new Worker(`) — the asynchronous paths, with topic and queue names.
6. Contracts: `*.proto`, `openapi.*`, `*.graphql`, `asyncapi.*`.
