# From code to Draft Canvas words

How to name what you found in a repository with the element types and relationship meanings Draft
Canvas draws natively. `get_capabilities` is the authority; this is the short version, with the code
signals that point to each one.

## Element types

| You found | `type` | `technology` example |
| --- | --- | --- |
| A web/mobile UI that is deployed on its own (SPA, Next.js app, iOS app) | `service` | `React, Vite` · `Next.js 15` · `SwiftUI` |
| An HTTP/gRPC/GraphQL backend whose job is serving an API | `api` | `Spring Boot 3` · `FastAPI` · `Go, chi` |
| A process that consumes a queue/stream or runs background jobs | `worker` | `Celery` · `Sidekiq` · `Node, BullMQ` |
| Cron, scheduled tasks, `@Scheduled`, Celery beat, CronJob | `scheduler` | `Kubernetes CronJob` |
| Ingress, API gateway, reverse proxy, load balancer, BFF router | `gateway` | `NGINX` · `Kong` · `AWS API Gateway` |
| Any other deployable of this system | `service` | |
| A system you call but don't own (Stripe, Auth0, a partner API, another team's service) | `external-system` | `Stripe API` · `REST` |
| PostgreSQL, MySQL, SQL Server, Oracle, SQLite | `sql-database` | `PostgreSQL 16` |
| MongoDB, DynamoDB, Cassandra, Firestore, Cosmos DB | `nosql-database` | `MongoDB 7` |
| Redis/Memcached used as a cache | `cache` | `Redis 7` |
| S3, GCS, Azure Blob, MinIO | `object-storage` | `Amazon S3` |
| Elasticsearch, OpenSearch, Meilisearch, Algolia (yours) | `search-index` | `OpenSearch` |
| A shared volume or file drop | `file-system` | `NFS` · `EFS` |
| SQS, RabbitMQ queue, Azure Service Bus queue, BullMQ/Sidekiq queue | `queue` | `Amazon SQS` |
| SNS, a RabbitMQ fanout exchange, Google Pub/Sub topic, EventBridge bus | `topic` | `Amazon SNS` |
| Kafka/Kinesis/Redpanda topic, Redis Streams (retained log) | `stream` | `Kafka` |
| A dead-letter queue/topic | `dead-letter-queue` | `Amazon SQS` |
| End users, admins, operators | `person` (`user-group` for a team) | |
| A partner or provider that *starts* interactions (a webhook sender) | `external-actor` | |
| A device that talks to the system (POS terminal, IoT sensor) | `device` | |
| A controller, handler, use case, domain module inside one container | `component` | `Spring MVC Controller` · `Express router` |
| A package/module boundary in a modular monolith | `module` | |
| A repository/gateway/client class that adapts to infrastructure | `adapter` | `JPA repository` · `Stripe SDK` |
| An interface the core defines and adapters implement | `port` | `Java interface` |

Redis is the usual trap: used with `GET/SET/EXPIRE` it is a `cache`; used for BullMQ/Sidekiq/RQ it is
the broker behind a `queue`; with `XADD`/`XREAD` it is a `stream`. Draw what the code does with it,
and give it one element per role it plays.

A local SQLite file in a CLI is still a `sql-database`. An ORM (Prisma, SQLAlchemy, Hibernate) is not
an element — it is the `technology` of the component that uses it, or of the adapter.

## Relationship meanings

Leave `semantic` out and the app infers it from the two element types, as the editor does — that is
right most of the time. Set it when the code says something more specific:

| Code does | from → to | `semantic` | `kind` |
| --- | --- | --- | --- |
| HTTP/REST call | service → service/external | `http` | `sync` |
| gRPC call | service → service | `grpc` | `sync` |
| Sends a command message to one handler | service → queue | `command` | `async` |
| Publishes an event | service → topic/stream | `publishes` | `event` |
| A topic delivers to a subscriber | topic → service | `deliversTo` | `event` |
| A topic feeds per-consumer queues | topic → queue | `fansOut` | |
| A worker pulls from its queue | queue → worker | `consumes` | `async` |
| Reads / writes / both | service → store | `reads` · `writes` · `readsWrites` | |
| Evicts cache entries | service → cache | `invalidates` | |
| Searches / indexes | service → search-index | `searches` · `indexes` | |
| Moves data between stores (ETL, replication, CDC) | store → store | `ingests` · `replicates` · `cdc` · `transforms` | |
| Parks failed messages | queue/worker → dead-letter-queue | `deadLetters` (+ `deliveryAttempts`) | |
| A scheduler starts a job | scheduler → worker/service | `triggers` | |
| A gateway routes a path | gateway → service | `routes` | |
| An in-process call between modules | component → component | `uses` | |
| An adapter implements a port | adapter → port | `implements` | |
| Undoes an earlier step (saga) | service → service | `compensates` | `failure` |
| A webhook or callback | external → service | `http` | `callback` |
| A retry or fallback path | any | as the call | `retry` · `fallback` |

`response` on a synchronous call draws its reply line: `true`, or a label such as `"201 Order"`. Use
it on the main path's key calls, not everywhere. `condition` adds a short guard under the label
("amount > 0", "if cache miss").

One relationship per direction between two elements. When a caller both reads and writes, that is one
`readsWrites`, not two lines.

Not every meaning fits every pair: a gateway `routes` to a service rather than `grpc`, a topic
`deliversTo` its subscribers rather than being `consumes`d. A meaning the pair doesn't offer is
replaced on create with an advisory; `check_diagram.py` warns first, naming the ones that fit.

**Event or command?** Name it by what the message means in the code, not by the broker's routing:
`OrderPlaced` (something that happened, past tense, any number of listeners) is an event — `publishes`
to a `topic` or `stream`; `MakeDrink` (do this, one handler) is a command — `command` to a `queue`.
A RabbitMQ direct exchange bound to one queue per consumer is still a queue per consumer; a fanout or
topic exchange that several services each bind their own queue to is a `topic` that `fansOut` to
those queues.

## Labels that read well

- **Elements:** Title Case, the name people say: "Orders API", "Checkout Web", "Payments Worker". Not
  the repository folder (`orders-svc-v2`), and never the technology — that has its own field.
  Ideally ≤ 24 characters.
- **Descriptions:** one sentence, a verb first, ≤ 90 characters: "Takes orders and reserves stock."
- **Relationships:** a verb phrase from the caller's side, ≤ 32 characters: "Places order",
  "Publishes OrderPlaced", "Reads product prices", "Charges card". Name the message or event when the
  code names it.
- **Flow step captions:** what happens at that step in this request, ≤ 80 characters, present tense:
  "Validates the cart and reserves stock for each line."
- **Groups:** the system's or domain's name, as people say it: "Storefront Platform", "Payments".
- **Colour:** leave elements neutral. A flow takes one accent (`teal`, `blue`, `violet`, `amber`,
  `rose`, `green`); failure variants read well in `rose` or `amber`.
