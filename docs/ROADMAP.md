# Roadmap

Numbered phases, ordered by dependency rather than by date — a later phase generally builds on a
capability an earlier one shipped. Each phase item gets a stable number (`4.3`) so it can be
referenced in discussion without restating it.

**Status legend:** ✅ Done · 🚧 In progress · ⬜ Planned · 🧪 Exploratory (an idea worth naming, not
yet a commitment)

| Phase | Name | Status |
| --- | --- | --- |
| [0](#phase-0--foundation) | Foundation | ✅ Done |
| [1](#phase-1--core-canvas-experience) | Core Canvas Experience | ✅ Done |
| [2](#phase-2--developer-diagram-semantics) | Developer Diagram Semantics | ✅ Done |
| [3](#phase-3--flow--presentation) | Flow & Presentation | ✅ Done |
| [4](#phase-4--export--sharing) | Export & Sharing | 🚧 Animated export done, ticket export next |
| [5](#phase-5--personalization) | Personalization | ⬜ Planned |
| [6](#phase-6--contextual-learning) | Contextual Learning | ⬜ Planned |
| [7](#phase-7--future--experimental) | Future / Experimental | 🧪 Exploratory |

**What's next:** [4.4 Export for Ticket](#44-export-for-ticket--planned-later), or start on
[Phase 5](#phase-5--personalization) — 4.4 isn't scheduled ahead of it.

## Product principle

> The user decides what connects. Draft Canvas decides how to make it look good.

More broadly: **everything in Draft Canvas should exist with intention.** It's a lightweight,
local-first, developer-oriented technical whiteboard for sketching and explaining systems during a
meeting — not a replacement for draw.io, Lucidchart, a UML/BPMN tool, or general-purpose design
software. Every phase below is evaluated against that, not against what a bigger tool in this space
would eventually grow into.

---

## Phase 0 — Foundation

*Purpose: a diagram you can trust with real work — private by construction, never silently lost.*

- **0.1 Local-first, no-network architecture** — ✅ Done. No backend, no accounts. A build-time test
  fails on `fetch`/`XMLHttpRequest`/`WebSocket`/etc. appearing anywhere; production CSP sets
  `connect-src 'none'`.
- **0.2 One renderer** — ✅ Done. `nodes/describe.ts` produces the same display list the canvas
  paints and the exporter serializes — an export is what you saw, not a reinterpretation of it.
- **0.3 Local persistence & autosave** — ✅ Done. IndexedDB, debounced autosave, a summary store so
  the library screen never deserializes a full document just to list it.
- **0.4 Encrypted storage at rest** — ✅ Done. Documents are encrypted in IndexedDB with a
  non-extractable, profile-wide AES-256-GCM key; `.dcenc` offers a passphrase-protected portable
  export independent of the local key.
- **0.5 Undo/redo history** — ✅ Done. Snapshot-based with structural sharing; a drag or resize is
  one history entry, not one per frame.

## Phase 1 — Core Canvas Experience

*Purpose: the ten seconds between "I need a box" and having one, for the shapes a developer
actually reaches for.*

- **1.1 Shape & card vocabulary** — ✅ Done. Card, text, note, code, plus developer presets
  (service, database, queue, actor, group). Double-click to create, no modal in the way.
- **1.2 Drag-to-connect & drop-to-create** — ✅ Done. Drag from a node's edge to connect; drop on
  empty canvas and the node you were heading for is created for you.
- **1.3 Resize** — ✅ Done.
- **1.4 Groups & boundaries** — ✅ Done. A loose, technology-neutral boundary caption (system,
  domain, network, deployment) without a heavyweight container model.
- **1.5 Focus Mode** — ✅ Done. An arbitrary, unordered highlight reachable at any time in edit mode
  — deliberately not a variant of Flow playback; never persisted, never in history.
- **1.6 Syntax-highlighted code cards** — ✅ Done. Java, JSON, YAML, XML, SQL, shell, HTTP, log
  output — for reading and explaining, not for writing programs.
- **1.7 Keyboard-first interaction** — ✅ Done. Single-key shape shortcuts, full undo/redo/copy/
  paste/duplicate, a discoverable shortcuts sheet.

## Phase 2 — Developer Diagram Semantics

*Purpose: a connector that means something specific, so the diagram reads as an architecture, not
a collection of arrows.*

- **2.1 Persisted connector anchors & routing** — ✅ Done. An anchor, once set by a drag, is never
  silently moved by routing — only an explicit reconnect changes it.
- **2.2 Lane-aware routing & obstacle avoidance** — ✅ Done. Parallel edges fan out instead of
  overlapping; a narrow single-detour heuristic keeps a connector clear of the node it would
  otherwise cross.
- **2.3 Service/Database/Queue kind variants** — ✅ Done. A small caption (`API`, `SQL`, `STREAM`, …)
  refines a node's meaning without touching its base silhouette or color.
- **2.4 Capability-aware semantic inference & color** — ✅ Done. The toolbar infers a likely
  connection meaning from the two node kinds involved (`categoryOf`/`capabilityFor`), and a
  connector's color follows suit — always overridable, never locked in.
- **2.5 Connector kind vocabulary** — ✅ Done. `sync`/`async`/`event`/`callback`/`conditional`/
  `retry`/`failure`/`fallback` as a small, fixed line-treatment vocabulary — not a protocol
  taxonomy.
- **2.6 Geometry-aware labels & drag-to-reconnect** — ✅ Done. A label anchors to whichever side of
  the line reads best rather than sitting dead-center; an existing connector can be dragged to a
  new endpoint with a live preview.
- **2.7 Connector attachments** — ✅ Done. A note or code card can be dragged onto a connector to
  attach as detail; multiple attachments render as independent, hover-revealed chips.

## Phase 3 — Flow & Presentation

*Purpose: draw the system once, then tell as many stories over it as the meeting needs.*

Applying the same principle one layer up: **the user defines what the system is and how the flow
progresses; Draft Canvas decides how to present it clearly.**

- **3.1 Flow storytelling** — ✅ Done. A `DraftFlow` is a named, ordered path over connectors that
  already exist — it never duplicates a node or edge, only orders references to them.
- **3.2 Presentation Mode** — ✅ Done. Step-by-step playback: active connector and endpoints stay
  lit, a pulse shows direction, everything else quietens without disappearing.
- **3.3 Conditional flow** — ✅ Done. A free-text condition chip (`[approved]`, `[timeout]`) marks a
  branch; branching itself is two Flows sharing early steps, not a decision-diamond node.
- **3.4 Async / event flow semantics** — ✅ Done. Solid vs. dashed for sync/async, with `event` as a
  distinct connector kind for a publish/consume-style interaction.
- **3.5 Callback / response visualization** — ✅ Done. A reply is a connector drawn the other way; a
  `callback` kind gives its return path a hollow arrowhead so direction reads at a glance.
- **3.6 Frame steps** — ✅ Done. A step can spotlight a group of nodes and connectors — or pin an
  exact camera position — instead of, or alongside, a single connector. Used for a scene-setting or
  boundary moment a single edge can't carry.

## Phase 4 — Export & Sharing

*Purpose: get the diagram, and eventually the explanation, out of the browser and into wherever
engineering work actually happens — a PR, a ticket, a Slack thread.*

- **4.1 Static export** — ✅ Done. `.draftcanvas` (source), SVG, and PNG, all from the same display
  list Phase 0.2 established.
- **4.2 Secure export/import** — ✅ Done. Passphrase-protected `.dcenc` (independent key material,
  ≥600k-iteration PBKDF2), with a warning on plain export.
- **4.3 Animated Flow Export (GIF)** — ✅ Done. Export a Presentation Mode walkthrough
  (Phase 3) as a GIF someone can open in a ticket without reopening Draft Canvas. Key constraints:
  - **GIF only, first.** Not a general media pipeline — a GIF behaves like an image (no player
    chrome, loops on its own), which matches how a short step-by-step walk should be consumed.
  - **Reuses Presentation Mode; does not get its own animation system.** The export is the existing
    playback — active connector, pulse, quieted rest-of-canvas, per-step viewport — captured to
    frames. No keyframe editor, timeline, transition designer, or a parallel diagram copy built for
    animation. If a step needs to look different for a good export, that's a Presentation Mode
    change, not an export-only branch.
  - **Small export UI.** Speed and loop are the entire surface; no FPS, codec, or bitrate exposed
    to the user.

  Built headlessly rather than by screen-capturing the live canvas: a per-frame renderer
  (`render/svg/flowFrame.ts`) reuses the same display-list pipeline as 4.1/4.2, decorated with the
  same active/shown/hidden tiers and connector pulse Presentation Mode itself computes
  (`explainNodeTier`/`explainEdgeTier`, `dc-flow-pulse`), so a frame can never drift from what
  Presentation Mode looks like live, and stays deterministic rather than sampled off wall-clock
  CSS animation.
- **4.4 Export for Ticket** — ⬜ Planned (later). One action producing both `architecture.png` (the
  structural reference) and `flow.gif` (the interaction explanation) for the current Flow. A
  packaging convenience on top of 4.1 and 4.3, not a separate export architecture — not scheduled
  ahead of 4.3.

## Phase 5 — Personalization

*Purpose: developers spend real time looking at this canvas during meetings and planning — letting
the workspace feel a little personal costs nothing on the technical model of the diagram.*

**Make the workspace personal without making the diagramming tool complicated.** This is a delight
capability, not a diagramming one — it belongs after the phases that make the tool actually work,
and is priced accordingly: high delight, low-to-medium strategic priority.

- **5.1 Custom canvas background** — ⬜ Planned. A user picks a local image as the canvas's visual
  background (Canvas Settings → Appearance → Background → choose an image). Stays local — no
  upload, no backend, no automatic remote fetch, consistent with Phase 0.1.
  - **Readability comes first.** A subtle overlay always sits between the image and diagram content
    — opacity/dim, optional blur, and a fit mode (cover/contain/tile) are the whole control surface.
    In practice this is closer to one dominant "dim background" slider than a set of independent
    knobs.
  - **Decoration only.** The background lives at the canvas/view layer, not as a diagram object: not
    selectable, no pointer events, no participation in grouping/alignment/routing, invisible to
    keyboard shortcuts. This is a different thing from an *image node* — the "deliberately not
    built" list in `docs/ARCHITECTURE.md` rules out images as diagram elements you wire into a
    system; a canvas-wide backdrop is never that.
  - **Default stays clean.** Nobody who doesn't open this setting sees any new complexity or
    toolbar clutter.
  - **Touches export and presentation.** Visual exports (4.1) default to including the background,
    with an "Include canvas background" export option for a clean technical diagram when it's not
    wanted. Presentation Mode may dim the background further for readability, but never surprises —
    focused nodes and flow highlights stay dominant over the wallpaper.
  - **Persistence is a real open question, not a default.** No blob/asset store exists in the
    storage layer today (Phase 0.3) — the smallest addition that avoids duplicating large images
    across documents is the right target, sized when this is actually built, not speculated on
    here.

What this will not become, regardless of how reasonable any one piece sounds in isolation: a
Canva-style design tool, stickers or a decorative object library, photo filters/editing, gradient
builders, animated wallpapers, a background marketplace, or dozens of themes. One image, one
overlay, done.

## Phase 6 — Contextual Learning

*Purpose: by Phase 4, Draft Canvas has real depth — semantics, connector kinds, attachments,
conditions, callbacks — and none of it should require reading documentation to find. The product
should teach itself, in the moment a question would naturally come up, without ever interrupting a
meeting.*

**Core principle: documentation should appear where the question happens.** Not a walkthrough that
runs once at the start and is gone, not a growing pile of tooltips — a small set of contextual,
dismissible primitives placed exactly where a specific question would occur, retired automatically
once the answer is no longer needed. Draft Canvas already has one instance of this instinct: the
blank-canvas empty state (Phase 1.1, `EmptyState.tsx`) is one line and three shortcuts, not a tour
— its own doc comment already says "no hint, no tour, no dismissible cards." This phase generalizes
that instinct into a reusable pattern instead of inventing a separate onboarding flow per feature.

- **6.1 Contextual hints & first-use coachmarks** — ⬜ Planned. Small, dismissible explanations
  tied to a specific canvas moment — the first Service node selected ("You can attach notes or code
  to this"), the first connector selected ("Connections can describe HTTP, events, callbacks, and
  other interactions"), an empty attachment slot ("Add context → Note · Code"). Each shown once, in
  place, never as a modal.
- **6.2 Usage-inferred learning state** — ⬜ Planned. A hint retires the moment its behavior is
  demonstrated, not only when it's dismissed: attach a note once and note-attachment hints never
  show again; edit a connector's label once and connector-semantics hints stop; open the command
  menu once and the hint pointing at `/` disappears. An explicit dismissal (×) is the fallback, not
  the primary path.
- **6.3 "New" feature indicators** — ⬜ Planned. A small badge on a newly discoverable capability —
  for something too minor to earn its own coachmark, this is the whole treatment.
- **6.4 "Learn Draft Canvas" mode** — ⬜ Planned. An optional, user-triggered (`?`) mode that
  surfaces contextual explanations across the canvas for someone who wants a deliberate pass,
  rather than picking hints up incidentally. Nothing shows unless asked for — this is the opt-in
  complement to 6.1's opt-out-by-default hints, not a second onboarding system.

**Guidance behavior, non-negotiable across all four:** contextual (tied to the moment, not a fixed
sequence), non-blocking, subtle, dismissible, shown only when relevant, shown once, remembered
locally, easy to rediscover manually (6.4) — and never shown during Presentation Mode. A hint
appearing mid-explanation is the one failure mode this phase exists to prevent; Presentation Mode
(3.2) is exactly where "the meeting" is happening.

**Persistence** reuses `src/lib/preferences.ts` (0.3) — which hints have already fired is a small,
local, non-document fact, the same shape as the existing theme preference, not a reason to
introduce a new store.

**Architecture:** small, reusable primitives — a hint component, a first-use flag, empty-state
guidance, feature-discovery metadata — not a generic tutorial framework. A future feature that
needs to introduce something new (4.3's export dialog, 5.1's background setting) should reach for
these same primitives rather than invent its own tooltip or walkthrough system; this phase exists
partly to make that the obvious default.

What this will not become: a forced walkthrough or multi-step product tour, a large welcome modal,
a tooltip that keeps reappearing after its feature is already learned, or documentation someone has
to leave the canvas to read. If an explanation needs more than a sentence, it belongs in `docs/`,
not in a hint.

## Phase 7 — Future / Experimental

*Purpose: named so they're not forgotten, not committed to.*

- **7.1 Longer-form export (MP4)** — 🧪 Exploratory. Worth revisiting only if a longer or
  higher-fidelity walkthrough than 4.3's GIF turns out to be genuinely needed. WebM stays out
  entirely unless a concrete need for it shows up — no reason to support it speculatively.

## Standing non-goals

Unchanged, from `docs/ARCHITECTURE.md`'s "Deliberately not built": authentication, accounts, cloud
sync, collaboration, comments, AI generation, template libraries, provider icon packs, Mermaid
import/export, image nodes, PWA install. This roadmap doesn't revisit any of them, and nothing
above — including 5.1's background image — reopens that list.
