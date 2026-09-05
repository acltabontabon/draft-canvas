# Draft Canvas

**Architecture at meeting speed.**

A local-first, opinionated architecture canvas for developers.

[![CI](https://github.com/acltabontabon/draft-canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/acltabontabon/draft-canvas/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

![Draft Canvas — for meetings that suddenly need a diagram](public/og-image.png)

Sometimes you're in a meeting and suddenly need to explain a system. You don't want to open a
heavyweight diagramming suite, hunt through hundreds of cloud icons, or spend five minutes aligning
rectangles. You want to draw the architecture, explain it, and move on.

That is Draft Canvas.

**[Try the live demo →](https://acltabontabon.com/draft-canvas/)** — nothing you draw there leaves
your browser either.

Your diagrams are stored locally in your browser.

- No account.
- No cloud document storage.
- No canvas uploads.

---

## Philosophy

**Fast where speed matters.** Opening Draft Canvas should feel closer to grabbing a marker than
opening an enterprise modeling tool. If you spend more time formatting the diagram than explaining
the idea, the tool has failed.

**Opinionated where correctness matters.** Draft Canvas understands some architectural
relationships — a service writes to a database, a queue is consumed rather than published into, a
topic fans out — and nudges you toward the technically sensible version of what you drew. See
[docs/architecture-semantics.md](docs/architecture-semantics.md) for exactly what it understands
today.

**Local-first.** Your diagrams belong to you. No account, no backend, no cloud sync — see
[Privacy](#privacy) below.

**Architecture, not icon collecting.** The goal is communicating systems clearly, not reproducing
an AWS architecture poster. There's no provider icon library, and there isn't going to be one.

**An escape hatch is always available.** Opinionated guidance helps you; it never turns the canvas
into a rigid modeling language. Draft Canvas suggests and warns — it never blocks a connection you
drew on purpose.

## What it does

**Draw** — Double-click anywhere to start and pick what you need. A small, deliberate set of
shapes: text, notes, and developer presets for services, databases, queues and actors. Drag from
a node's edge to connect it; drop on empty canvas and the node you were heading for is created for
you.

**Drop in code** — Syntax-highlighted cards for Java, JSON, YAML, XML, SQL, shell, HTTP and log
output. For reading and explaining, not for writing programs.

**Tell the story** — A Flow is a named, ordered path through connections you've already drawn:
select a connector, add it to a Flow, give it an optional caption. Draw your architecture once and
build as many Flows over it as you have scenarios — *Happy path*, *Payment timeout*, *Retry* — each
reusing the same nodes and connectors, sharing early steps and diverging later. Switching Flows
never touches the diagram.

**Walk through it** — Press Present, pick a Flow if there's more than one, and step through it one
connection at a time. The active connector and its two endpoints stay lit, a subtle pulse shows
which way the conversation is going, and everything else quietens without disappearing. Arrow keys
move. A connector can carry a payload that appears only on its step, so the canvas stays clean.

**Mark the details** — A connector defaults to a solid line (synchronous); mark it `async` for a
dashed one — a queue publish, an event, a webhook. A free-text condition chip (`[approved]`,
`[timeout]`) explains a branch without a decision diamond.

**Keep it** — Edits save to this browser automatically. Export a `.draftcanvas` file to keep a
copy you control, or a PNG or SVG for a README, a pull request, or Slack.

## Privacy

> Your diagrams stay on your device. Draft Canvas does not upload or store your canvas on a
> server.

That is a technical statement, not a marketing one, and it is enforced rather than promised:

- **No request ever carries anything you draw.** There is no backend, no API, no analytics.
- The production build ships a `connect-src 'self'` Content Security Policy, so the browser
  itself blocks any request to another origin — a dependency could not phone home even if it
  tried. The only same-origin traffic that exists is the offline Service Worker (Phase 6)
  fetching the app's own assets and checking for updates — never your diagrams.
- A test walks the whole source tree and fails the build if `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource` or `sendBeacon` appear anywhere in the app's own code.
- There is no analytics, no telemetry, and no error reporting.

Diagrams live in IndexedDB in this browser. `localStorage` holds nothing but your theme choice.
See [docs/PRIVACY.md](docs/PRIVACY.md) for exactly what is stored where.

**Clearing your browser's site data will delete your diagrams.** Export a `.draftcanvas` file
for anything you want to keep.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5180
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Type-check and produce a production build in `dist/` |
| `npm run preview` | Serve the production build |
| `npm run lint` | oxlint |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run e2e` | Browser tests (Playwright; run `npm run e2e:install` once first) |
| `npm run check` | Lint, build and unit tests together |

The build is path-agnostic (`base: './'`), so `dist/` can be served from any subdirectory.

## Keyboard

| Key | Action |
| --- | --- |
| `T` `N` `C` | Text · Note · Code, created under the cursor |
| `S` `D` `Q` `A` `J` | Service · Database · Queue · Actor · Junction |
| Double-click | Pick a type to create on empty canvas, or edit an element's text |
| Drag from an edge | Connect — drop on empty canvas to create the target |
| `Cmd/Ctrl` `Z` / `⇧Z` | Undo / redo |
| `Cmd/Ctrl` `C` `V` `D` | Copy · paste · duplicate |
| `Backspace` | Delete selection |
| `Shift` `1` | Fit to view |
| `Cmd/Ctrl` `Enter` | Present |
| `Cmd/Ctrl` `E` | Export |
| `→` / `Space` `←` | Next / previous step while presenting a Flow |
| `?` | All shortcuts |

## Documentation

- [Flows and Presentation Mode](docs/FLOWS.md) — telling a story over a diagram you already drew
- [Architecture](docs/ARCHITECTURE.md) — how the layers fit together, and why
- [Architecture semantics](docs/architecture-semantics.md) — exactly what Draft Canvas understands
  about the diagrams you draw, and what it doesn't
- [Document schema](docs/SCHEMA.md) — the `.draftcanvas` format, and how it evolves
- [Privacy implementation](docs/PRIVACY.md) — what is stored where, auditably
- [Roadmap](docs/ROADMAP.md) — numbered phases from what's shipped to what's next, no dates

## Contributing

Bug reports, feature requests, and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how
to run it locally, the project's conventions, and — especially if you're touching connector
semantics — what makes a change technically defensible rather than just visually convenient. This
project follows a standard [Code of Conduct](CODE_OF_CONDUCT.md).

## Status

Draft Canvas is at `v0.4.0`. Every phase on the [roadmap](docs/ROADMAP.md) through Phase 8 has
shipped, each gated by its own test coverage and manual browser verification before release —
pre-1.0 mostly signals that the shape can still change, not that it's unfinished.

## Built with

[React](https://react.dev) and [Vite](https://vite.dev), with
[React Flow](https://reactflow.dev) for canvas interaction ·
[refractor](https://github.com/wooorm/refractor) for syntax highlighting ·
[idb](https://github.com/jakearchibald/idb) for local storage ·
[zustand](https://zustand.docs.pmnd.rs) for state ·
[gifenc](https://github.com/mattdesl/gifenc) for GIF export.

Seven runtime dependencies, all permissively licensed (MIT/ISC) — see
[docs/PRIVACY.md](docs/PRIVACY.md) and [SECURITY.md](SECURITY.md) for what the app itself does and
doesn't do with your data.

## License

[Apache License 2.0](LICENSE).

"Draft Canvas" and its logo identify this project. Forking, modifying, and reusing the code under
Apache 2.0 is welcome — just don't present a fork as the official Draft Canvas or as endorsed by it.
