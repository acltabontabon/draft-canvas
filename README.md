# Draft Canvas

**Draw it so everyone gets it.**

A diagramming tool for developers, built for the moment in a meeting when someone needs to draw
the architecture instead of just describing it. Open a blank canvas and start placing services,
queues, and databases: no account, no workspace to set up, nothing to configure first.

[![CI](https://github.com/acltabontabon/draft-canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/acltabontabon/draft-canvas/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<img width="100%" alt="A minute-and-a-half run through Draft Canvas: on a blank canvas, placing a service, naming it, and dragging a connector onto empty space to pick what lands; accepting the suggested worker with Tab; clearing it and using the command palette to drop in a composed CQRS architecture instead; changing two data stores' kinds from a grid of shape previews; dropping a note onto a connector and opening it to read it back; opening an attached code card; presenting a flow one connector at a time; and the whole editor following a switch to a light system theme" src="docs/media/demo.gif">

**[Try it →](https://acltabontabon.com/draft-canvas/)** Nothing you draw leaves your browser.

---

## Why this exists

Some meetings reach a point where someone just has to draw the damn thing.

You're deep in a conversation about a system, an integration, a flow, whatever, and it becomes
pretty clear that everyone's picturing a slightly different version of it. Someone grabs a
whiteboard, or screen-shares whatever half-finished diagram they still have open from last time.

I wanted a canvas I could open and immediately start dropping in services, queues, databases,
actors, and boundaries, without first dealing with an account, a workspace, or a shape library
the size of a small country.

That's basically the whole premise. Draft Canvas isn't trying to replace every diagramming tool
out there, and it's definitely not trying to become a full architecture modeling platform. It's
the tool I wanted for the fifteen minutes where a conversation gets a lot easier once someone
draws the thing.

---

## What it does

**Draw quickly**
- A focused shape set (Service, Datastore, Queue/Topic, Actor, Boundary, Table) reachable by
  keyboard, right-click, or the `⌘K` command palette.
- **Intent Continuation** guesses what probably comes next (a worker beside a queue, a service
  beside a route) as you draw. `Tab` accepts it, `Escape` ignores it.
- **Quick Connect**: drag a connector onto empty canvas and pick from ranked, live-previewed
  suggestions instead of guessing a shape first.
- Ten built-in starters for common patterns: Microservices, Event-Driven, Hexagonal, CQRS, Saga
  (Orchestration and Choreography), Transactional Outbox, and a few more. Real pre-wired
  diagrams, not blank templates.

**Architecture-aware**
- It knows what a Queue, a Service, a Datastore, and a Boundary are. Relationships like `calls`,
  `publishes`, `projects`, and `compensates` carry actual meaning, not just an arrow, and that's
  what drives the suggestions above.

**Flows and presentations**
- Group connectors into a **Flow** and walk through it one step at a time with **Present**,
  instead of dumping the whole diagram on someone at once.
- Export a flow straight to a sequence diagram (Mermaid or PlantUML). No redrawing it by hand
  afterward.

**Keyboard-first**
- `Alt+Arrow` jumps between neighboring elements, `Alt+Shift+Arrow` follows a connection, and
  anything you create from the keyboard opens ready to name.
- Palette, right-click menu, and keyboard shortcut for any given action all go through the same
  command. Nothing is palette-only or menu-only.

**Local by default**
- Everything lives in IndexedDB on your machine, encrypted at rest (AES-256-GCM). No backend,
  no account, no analytics. This isn't just a privacy policy either: a build-time test fails if
  any network call shows up in the source. See [`docs/PRIVACY.md`](docs/PRIVACY.md) for how
  that's actually verified, not just claimed.
- Works offline once you've loaded it the first time (it's a PWA).

**Export it and move on**
- `.draftcanvas` (plain JSON, diffable), `.dcenc` (passphrase-encrypted, for sharing somewhere
  less trusted), or PNG/SVG. What you see on screen is what gets exported: same renderer, not a
  second one that mostly agrees with the first.

---

<!-- performance:start -->
## Performance

On a typical architecture diagram (~90 nodes — services, databases, queues, boundaries), Draft Canvas loads in about 151 ms and settles at about 15 MiB of memory; dragging a node takes about 366 ms. A larger, more detailed diagram (~225 nodes) loads in about 502 ms and uses about 29 MiB.

| Diagram | Size | Load time | Memory (JS heap) | Dragging a node |
|---|---|---|---|---|
| Typical | 90 nodes / 79 connections | 151 ms | 15 MiB | 366 ms |
| Large | 225 nodes / 192 connections | 502 ms | 29 MiB | 385 ms |

Measured against the production build in Chromium, on real architecture diagrams (not synthetic shapes) built from Draft Canvas's own starter catalog. These are reference-machine numbers, not a guarantee for every device.

Measured on: Apple M2 Pro, macOS 25.6.0, Chromium 151.0.7922.34, Draft Canvas 0.8.0.

![JS heap vs. diagram size](benchmark/memory-chart.svg)

