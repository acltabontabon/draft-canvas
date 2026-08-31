# Draft Canvas

**A local-first canvas for developers to explain software visually.**

Draft Canvas is a lightweight technical whiteboard for architecture discussions, debugging
sessions, brainstorming, and walking someone through a flow.

Your diagrams are stored locally in your browser.

- No account.
- No cloud document storage.
- No canvas uploads.

---

## Why

Most diagramming tools are built for producing documents. This one is built for the ten minutes
in a meeting where you need to show someone how something works — and then get back to the
conversation.

Everything is aimed at one thing: **speed of thought**. If you spend more time formatting the
diagram than explaining the idea, the tool has failed.

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

- The application makes **no network requests at all** after it loads. There is no backend.
- The production build ships a `connect-src 'none'` Content Security Policy, so the browser
  itself blocks any request — a dependency could not phone home even if it tried.
- A test walks the whole source tree and fails the build if `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource` or `sendBeacon` appear anywhere.
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
| `S` `D` `Q` `A` `O` | Service · Database · Queue · Actor · Circle |
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
- [Document schema](docs/SCHEMA.md) — the `.draftcanvas` format, and how it evolves
- [Privacy implementation](docs/PRIVACY.md) — what is stored where, auditably
- [Roadmap](docs/ROADMAP.md) — numbered phases from what's shipped to what's next, no dates

## Built with

[React](https://react.dev) · [Vite](https://vite.dev) ·
[React Flow](https://reactflow.dev) for canvas interaction ·
[refractor](https://github.com/wooorm/refractor) for syntax highlighting ·
[idb](https://github.com/jakearchibald/idb) for local storage ·
[zustand](https://zustand.docs.pmnd.rs) for state.

Six runtime dependencies, all permissively licensed.

## Licence

MIT
