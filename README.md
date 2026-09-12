# Draft Canvas

An opinionated diagramming tool for devs to sketch fast when a meeting suddenly needs a diagram. No cloud, no account — just draw. Draft Canvas understands architecture: it nudges you toward sensible connections and exports pixel-perfect SVG, PNG, or GIF.

[![CI](https://github.com/acltabontabon/draft-canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/acltabontabon/draft-canvas/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<img width="100%" alt="A minute-and-a-half run through Draft Canvas: on a blank canvas, placing a service, naming it, and dragging a connector onto empty space to pick what lands; accepting the suggested worker with Tab; clearing it and using the command palette to drop in a composed CQRS architecture instead; changing two data stores' kinds from a grid of shape previews; dropping a note onto a connector and opening it to read it back; opening an attached code card; presenting a flow one connector at a time; and the whole editor following a switch to a light system theme" src="docs/media/demo.gif">

<sub>A minute and a half, start to finish — <a href="docs/media/demo.mp4">sharper as MP4</a>.</sub>

**[Try it →](https://acltabontabon.com/draft-canvas/)** Nothing you draw leaves your browser.

## Why local-first

Your diagrams stay on your device. No account. No backend. No sync. After the first load it runs
with no network at all — on a plane, on hotel wifi, or with the tab open and the cable pulled.

This is enforced, not a promise: the build fails if `fetch`, `XMLHttpRequest`, WebSocket, or
analytics code appear anywhere. The production CSP blocks any request to another origin. A Service
Worker caches the app itself; it never touches your diagrams.

What's stored is encrypted at rest — AES-256-GCM, under a key your browser generates and keeps
non-exportably, which Draft Canvas itself can never read back. Titles are the deliberate exception:
they stay readable so the library can list your diagrams without decrypting every one.

See [docs/PRIVACY.md](docs/PRIVACY.md) for what's stored where.

⚠️ **Clearing your browser's site data deletes your diagrams.** Export a `.draftcanvas` file
for anything you want to keep.

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

Full methodology, limitations, and how to reproduce this: [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).
<!-- performance:end -->
