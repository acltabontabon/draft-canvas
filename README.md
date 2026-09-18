# Draft Canvas

You're in a meeting explaining a system. Someone needs to see it drawn.

So you start diagramming. Then you're **adjusting connectors, moving things around, figuring out how to represent** what you're talking about. Before long, **you're spending more time making the diagram than explaining the idea.**

**Draft Canvas is built to reduce that friction.**

It gives you **architecture-aware shapes**, familiar technical relationships, and small assists where they help — **enough to spend less time wrestling with the diagram and more time visualizing and explaining the system.**

[![CI](https://github.com/acltabontabon/draft-canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/acltabontabon/draft-canvas/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/acltabontabon/draft-canvas.svg)](https://hub.docker.com/r/acltabontabon/draft-canvas)
[![VS Code](https://img.shields.io/badge/VS%20Code-Marketplace-007ACC)](https://marketplace.visualstudio.com/items?itemName=acltabontabon.draft-canvas)
[![GitHub Release](https://img.shields.io/github/v/release/acltabontabon/draft-canvas)](https://github.com/acltabontabon/draft-canvas/releases)

<img width="100%" alt="A run through Draft Canvas in six chapters: on a blank canvas, pressing a letter to drop a service under the cursor, naming it, dragging a connector into empty space to pick a queue, and accepting the suggested worker with Tab; clearing it and using the command palette to drop in a composed CQRS architecture; writing a note and dropping it onto a connector; presenting a flow step by step, with close-ups of the code sample, the dropped note threaded with the starter's own note, and the read store's note appearing on their steps; looking inside the Write Model with Cmd+Down, drawing an order handler and its data store there, opening the depth map that shows the room inside the Orders canvas, and coming back out with Cmd+Up; opening the Learn handbook beside the canvas, searching for dead-letter queues and watching the recipe play; and the editor following a switch to a light system theme" src="docs/media/demo.gif">

**[Try it →](https://acltabontabon.com/draft-canvas/)** Nothing you draw leaves your browser.

Also lives [in VS Code](#in-vs-code), next to your code, and [in Docker](#running-it-yourself), on your own server.

---

## What it does

- **Architecture-aware shapes** — Service, Datastore, Queue/Topic, Actor, Boundary that understand what they mean
- **C4-aware nesting** — Look inside any shape to draw what runs there; stay at System, Container, or Component level
- **Flows & presentations** — Group connectors into flows and present step-by-step; export to Mermaid or PlantUML
- **Keyboard-first** — Type a letter to drop shapes, Alt+Arrow to jump, Tab to accept suggestions
- **Local by default** — IndexedDB, encrypted at rest, no backend or account needed
- **Offline-capable** — Works offline once loaded; zero network calls enforced by build-time tests
- **Ten starters** — Microservices, Event-Driven, Hexagonal, CQRS, Saga, Outbox, and more
- **Export ready** — `.draftcanvas` JSON, encrypted `.dcenc`, or PNG/SVG; pixel-perfect

---

## In VS Code

Keep the diagram next to the code it describes.

```text
payments-service/
├── src/
└── docs/
    └── architecture/
        └── checkout.draftcanvas   ← click it, you're on the canvas
```

Install [Draft Canvas for VS Code](https://marketplace.visualstudio.com/items?itemName=acltabontabon.draft-canvas),
open any `.draftcanvas` file, draw, and `⌘S`. The diagram saves back to that file as plain JSON, so
it shows up in a pull request like everything else. `Draft Canvas: New Diagram` starts a fresh one.

---

## Running it yourself

The same static app as the hosted version, served by nginx. No backend, nothing to configure.

```bash
docker run -d --name draft-canvas -p 8080:80 acltabontabon/draft-canvas
```

Then open http://localhost:8080. `latest` follows stable releases; pin a tag like
`acltabontabon/draft-canvas:1.5.0` to stay put.

Serving it to other machines? Put it behind HTTPS. Browsers only allow the encryption Draft Canvas
saves with on HTTPS or `localhost`, so over plain `http://192.168.x.x` it can't save anything.

---

<!-- performance:start -->
## Performance

On a typical architecture diagram (~90 nodes — services, databases, queues, boundaries), Draft Canvas loads in about 478 ms and settles at about 17 MiB of memory. A larger, more detailed diagram (~225 nodes) loads in about 747 ms and uses about 32 MiB.

| Diagram | Size | Load time | Memory (JS heap) | 40-step drag |
|---|---|---|---|---|
| Typical | 90 nodes / 79 connections | 478 ms | 17 MiB | 680 ms |
| Large | 225 nodes / 192 connections | 747 ms | 32 MiB | 681 ms |

Measured against the production build in Chromium, on real architecture diagrams (not synthetic shapes) built from Draft Canvas's own starter catalog. These are reference-machine numbers, not a guarantee for every device. The drag column is how long a scripted 40-step drag takes end to end — one step per frame at 60 Hz, so it is the length of the gesture rather than any lag in it; how each frame fares is in the next table.

Measured on: Apple M2 Pro, macOS 27.0.0, Chromium 153.0.8010.12, Draft Canvas 1.8.0.

![JS heap vs. diagram size](benchmark/memory-chart.svg)

**While you work.** How long a frame takes while panning, zooming, selecting and dragging in a big diagram (95th percentile; 16.7 ms is one frame at 60 Hz), and the longest freeze after dropping a shape, drawing a connector or renaming one:

| Diagram | Pan | Zoom | Select a shape | Drag | Longest freeze after an edit |
|---|---|---|---|---|---|
| Medium — 200 shapes / 300 connectors | 16.8 ms | 16.8 ms | 16.8 ms | 16.7 ms | none over 50 ms |
| Large — 500 shapes / 800 connectors | 16.8 ms | 33.2 ms | 16.8 ms | 16.8 ms | 115 ms |
| Stress — 1,000 shapes / 1,500 connectors | 33.4 ms | 66.7 ms | 66.7 ms | 50.0 ms | 230 ms |

These diagrams are generated, deliberately dense ones: boundaries nested three deep, connectors that cross boundaries and each other, notes and code on shapes and connectors, and shapes with a room inside. Measured with real mouse input against the production build (new headless Chromium 153.0.8010.12, 1600×1000 @1x, 3 runs each).

**Opening one, and working for a long time.** How long a diagram takes to appear after you choose it, the longest stretch the page cannot respond in that time, and what exporting it costs (SVG / PNG):

| Diagram | Opens in | Longest freeze while opening | Export |
|---|---|---|---|
| Small — 50 shapes / 75 connectors | 475 ms | 91 ms | – |
| Medium — 200 shapes / 300 connectors | 882 ms | 448 ms | 76 ms / 867 ms |
| Large — 500 shapes / 800 connectors | 2.6 s | 2.1 s | 77 ms / 1.7 s |
| Stress — 1,000 shapes / 1,500 connectors | 9.0 s | 8.4 s | 156 ms / 2.0 s |

100 saved diagrams show up in the library in 77 ms. Switching between diagrams 25 times grew the JS heap by 0.5 MiB in total, and left no DOM nodes or listeners behind. Dragging a shape out and back 150 times on the large diagram — enough to fill the undo history — took the heap from 86 MiB to 118 MiB, where it stopped growing.

Full methodology, limitations, and how to reproduce this: [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).
<!-- performance:end -->
