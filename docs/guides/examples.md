# Architecture examples

Use a starter to get an editable diagram with shapes, relationships and flows already in place.

On Home or an empty canvas, choose **Monolith**, **Microservices**, **Event-Driven**, **Hexagonal**
or **CQRS**. For the full catalog, open `⌘K` (`Ctrl+K` on Windows/Linux) and type a starter's name.

Starters add to the current canvas. Rename, delete or reconnect anything.
Click a name below to preview its diagram.

| Starter | Starting point |
| --- | --- |
| [Monolith](../media/guides/example-monolith.png) | One application with API, business logic and data access layers |
| [Modular Monolith](../media/guides/example-modular-monolith.png) | One deployable with separate modules |
| [Microservices](../media/guides/example-microservices.png) | Services with their own data, behind a gateway |
| [Event-Driven](../media/guides/example-event-driven.png) | A topic, subscriber queues, workers and a dead-letter queue |
| [Hexagonal](../media/guides/example-hexagonal.png) | A core with ports and adapters |
| [Backend for Frontend](../media/guides/example-bff.png) | A separate backend for each frontend |
| [CQRS](../media/guides/example-cqrs.png) | Command and query paths with an async read projection |
| [Medallion](../media/guides/example-medallion.png) | Raw, validated and business-ready datasets |
| [Kappa](../media/guides/example-kappa.png) | Live and historical processing through one stream |
| [Change Data Capture](../media/guides/example-cdc.png) | Committed changes feeding derived views |
| [Saga – Orchestration](../media/guides/example-saga-orchestration.png) | A coordinator managing local transactions and compensation |
| [Saga – Choreography](../media/guides/example-saga-choreography.png) | Local transactions coordinated through events |
| [Transactional Outbox](../media/guides/example-transactional-outbox.png) | Save state and event intent together, then publish |

Next: [edit shapes and connectors](shapes-and-connectors.md) or [present a flow](flows-and-presentation.md).
