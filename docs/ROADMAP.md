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
| [4](#phase-4--export--sharing) | Export & Sharing | ✅ Done (core) — 4.4 optional, not blocking |
| [5](#phase-5--personalization) | Personalization | ✅ Done |
| [6](#phase-6--offline-first-application-availability) | Offline-First Application Availability | ✅ Done — 6.7 exploratory, not blocking |
| [7](#phase-7--contextual-learning) | Contextual Learning | ✅ Done |
| [8](#phase-8--canvas-command-surface) | Canvas Command Surface | ✅ Done — 8.5-8.7 exploratory, not blocking |
| [9](#phase-9--future--experimental) | Future / Experimental | 🧪 Exploratory |
| [10](#phase-10--support-draft-canvas) | Support Draft Canvas | ⬜ Planned (low priority) |

**What's next:** every planned phase has shipped. What remains is optional or exploratory:
[4.4](#phase-4--export--sharing) (Export for Ticket), [8.5-8.7](#phase-8--canvas-command-surface)
(quick-create shorthand, name-resolving commands, recipes), [6.7](#phase-6--offline-first-application-availability)
(installable PWA), [9.1](#phase-9--future--experimental) (MP4), and
[Phase 10](#phase-10--support-draft-canvas) (Support Draft Canvas, deliberately low priority).
Phase 8 (Canvas Command Surface) shipped 8.1-8.4 — the `⌘K` palette, selection-aware commands with
two-step targets, canvas search and jump, and local command history — gated per sub-phase by the
full test suite, a new `e2e/command-palette.spec.ts`, and manual browser verification in both
themes and in Presentation Mode. 8.8 later added a right-click contextual menu as a third
invocation surface for the same commands, gated the same way with a new `e2e/context-menu.spec.ts`.
Phase 7 (Contextual Learning) shipped all four sub-phases — contextual hints folded into
the existing `ElementInspectorPopover`/`EdgeInspectorPopover` rather than a second floating overlay,
usage-inferred retirement via `semanticsOrigin`/attachment state, a "New" indicator on the Learn
Draft Canvas toolbar entry, and the opt-in Learn Draft Canvas mode itself — gated by the full test
suite and manual browser verification, including confirming every hint disappears immediately in
Presentation Mode. Phase 6 (Offline-First Application Availability) shipped 6.1-6.6, gated by the
full test suite, a new `dist`-backed Playwright suite (`playwright.dist.config.ts`,
`e2e/offline.spec.ts`), and manual browser verification against a killed origin server; 6.7
(installable PWA) stays 🧪 Exploratory, unchanged. Phase 5 shipped both 5.1 (custom canvas
background) and 5.2 (Intentional Roughness), gated by the full test suite and browser verification.

## Product principle

> The user decides what connects. Draft Canvas decides how to make it look good.

> This is a draft. It should be allowed to look like one.

> Draft Canvas should never lose a meeting because Wi-Fi disappeared.

More broadly: **everything in Draft Canvas should exist with intention.** It's a lightweight,
local-first, developer-oriented technical whiteboard for sketching and explaining systems during a
meeting — not a replacement for draw.io, Lucidchart, a UML/BPMN tool, or general-purpose design
software. Every phase below is evaluated against that, not against what a bigger tool in this space
would eventually grow into. The second principle is newer than the first but not lesser: a diagram
that looks too finished invites the wrong question in a meeting ("is this the real design?")
instead of the right one ("does this make sense?"). Phase 5.2 is where that principle gets a
rendering.

---

## Phase 0 — Foundation

*Purpose: a diagram you can trust with real work — private by construction, never silently lost.*

- **0.1 Local-first, no-network architecture** — ✅ Done. No backend, no accounts. A build-time test
  fails on `fetch`/`XMLHttpRequest`/`WebSocket`/etc. appearing anywhere in the app's own source;
  production CSP sets `connect-src 'self'` — no request to any other origin is possible. (Narrowed
  from `'none'` by Phase 6's offline Service Worker, which needs same-origin requests for its own
  asset caching and update checks — see Phase 6.)
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

- **1.1 Shape vocabulary** — ✅ Done. Text, note, code, plus developer presets (service, database,
  queue, actor, group). Double-click to create — a small picker, no modal in the way. (The
  original Card shape and its unreachable `rounded` duplicate were later removed, since
  Note/Text/the developer presets already cover what a semantics-free box was standing in for.)
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
- **3.7 Request/response interactions** — ✅ Done. A synchronous call (`GET Customer`) and its reply
  (`200 Customer`) are one connector, not two: an optional `response` chip renders as a quieter
  secondary line sharing the same geometry, compact until hovered, selected, or its own half of a
  two-phase Presentation Mode pulse is playing. Distinct from **3.5**'s `callback` kind, which
  stays the right tool for a reply that genuinely deserves its own connector.

## Phase 4 — Export & Sharing

*Purpose: get the diagram, and eventually the explanation, out of the browser and into wherever
engineering work actually happens — a PR, a ticket, a Slack thread.*

**Core scope done.** 4.1-4.3 cover the substance of "get it out of the browser" — a portable
source file, two static image formats, and an animated walkthrough. 4.4 is a packaging convenience
layered on top of what already exists, not a gap in the phase's purpose — it doesn't block calling
this phase done.

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
- **4.4 Export for Ticket** — ⬜ Planned (optional, doesn't block Phase 4). One action producing
  both `architecture.png` (the structural reference) and `flow.gif` (the interaction explanation)
  for the current Flow. A packaging convenience on top of 4.1 and 4.3, not a separate export
  architecture — genuinely optional, not merely deferred.

## Phase 5 — Personalization

*Purpose: developers spend real time looking at this canvas during meetings and planning — letting
the workspace feel a little personal costs nothing on the technical model of the diagram.*

**Make the workspace personal without making the diagramming tool complicated.** This is a delight
capability, not a diagramming one — it belongs after the phases that make the tool actually work,
and is priced accordingly: high delight, low-to-medium strategic priority.

- **5.1 Custom canvas background** — ✅ Done. A user picks a local image as the canvas's visual
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

- **5.2 Intentional Roughness** — ✅ Done. A restrained, semantics-aware visual personality —
  *controlled imperfection*, not a hand-drawn filter — that keeps the canvas reading as a working
  sketch rather than a finished specification. Three small presets: **Clean** (default, today's
  appearance, byte-for-byte unchanged), **Draft**, **Sketch** — not a theme-configuration screen.
  - **Product rationale.** Draft Canvas exists for the ten minutes of a meeting, not the finished
    artifact — a canvas that looks too polished invites the wrong scrutiny ("is this the real
    design?") instead of the right one ("does this make sense?"). This is the second product
    principle at the top of this document, given a rendering.
  - **Expected interaction.** One selector — Canvas Settings → Appearance → Personality, alongside
    5.1's background control, reusing the same settings surface rather than adding a new one. Three
    presets, no per-element toggles, no slider farm. A user who never opens this setting sees no
    change and no new UI.
  - **UX principles.** Understated over cartoonish: a user should think "this feels like a sketch,"
    never "someone applied a filter." Semantics-aware, not uniform — services/databases/queues stay
    structurally clear, with irregularity only at the outline, never the silhouette (2.3); notes and
    pen annotations can feel more informal; group boundaries (1.4) can look lightly drawn; a
    highlight can resemble a marker stroke. **Connections are the one element that never trades
    readability for personality** — label placement, direction, and attachment points stay exactly
    as legible as Clean at every setting, and topology never changes for visual style: a preset
    restyles a line 2.1/2.2 already routed, it never reroutes one.
  - **Architectural considerations.** A rendering-only concern layered onto Phase 0.2's display
    list, never onto the document model — `x`/`y`/`width`/`height`/anchors on a `DraftNode`/
    `DraftEdge` stay exact regardless of preset; only what `nodes/describe.ts` and
    `edges/describe.ts` emit gains controlled jitter, so selection, resize, routing, persistence,
    and any future layout algorithm stay fully deterministic. Because edges are Phase 0's one
    deliberate exception to "one renderer" (`DraftEdgeView.tsx` vs. `edges/describe.ts` stay
    hand-synchronized, per `docs/ARCHITECTURE.md`), a roughness treatment for connectors is — like
    every other connector visual — a second thing to build by hand, not something that falls out of
    one change.
  - **Dependencies.** 0.2 (one renderer, for the layering discipline); 2.1-2.7 (to know which
    element is a connector that must stay fully legible vs. a boundary or note that can flex); 3.2
    Presentation Mode and Phase 4 exports both need to carry the active preset through rather than
    silently reverting to Clean — "it should still look like the thing we just drew together."
  - **Recommended sequencing.** After 5.1: both are presentation-only settings on the same new
    surface, and 5.1 (a static image plus an overlay) is the simpler of the two — it validates that
    surface before 5.2 layers a second, more pervasive setting onto it.
  - **Acceptance criteria.** Clean renders pixel-identical to today. Switching presets never changes
    a stored coordinate, anchor, or edge endpoint — only the emitted display list. A connector stays
    fully readable at every preset. Presentation Mode and every export format (PNG, SVG, GIF, and
    any future MP4 per 9.1) preserve the active preset rather than reverting to Clean.

  What this will not become: cartoonish wobble, sketch textures that reduce legibility, hard-to-read
  hand-drawn fonts, randomized geometry, or a per-element style editor. If a diagram is harder to
  read in Draft or Sketch than in Clean, that's a bug, not a feature.

## Phase 6 — Offline-First Application Availability

*Purpose: local-first has, until now, meant the diagram data — this phase extends the same promise
to the application itself, so a meeting doesn't end just because Wi-Fi did.*

**Core principle:**

> First visit needs the internet. Every visit after that should consider the internet optional.

After a user successfully loads Draft Canvas once, refreshing or reopening the site while offline
should still start the application normally, using previously downloaded application resources —
the same instinct as 0.1's no-network document model, applied one layer up, to how the app itself is
delivered rather than to what it stores.

- **6.1 Application shell caching** — ✅ Done. A Service Worker registers on first successful
  load and caches the app shell — HTML, JS, CSS, fonts/icons, and other required static assets — in
  Cache Storage. A subsequent offline refresh or reopen serves the cached shell instead of failing;
  canvas data keeps living in IndexedDB (0.3) exactly as it does online. No offline expiration: a
  canvas opened once and left offline for days or weeks keeps working — there is no requirement to
  periodically reconnect to remain usable.
  - Fully useful while offline: create and edit diagrams, build and modify Flows, use Presentation
    Mode (3.2), work with notes/code/attachments (2.7), and save local changes (0.3). Export formats
    that don't depend on network access (4.1-4.3) keep working — nothing in the app should assume
    connectivity past the first load.
  - Requires an HTTPS-hosted static deployment with no backend dependency, consistent with the
    project's existing hosting model. Depends on 0.1 (no-network architecture — this phase's natural
    sibling, applied to delivery rather than data).
- **6.2 Smart application updates** — ✅ Done. *Use what you have. Fetch what's newer. Switch
  when it's safe.* On start, the currently cached application loads and becomes usable immediately —
  no blocking update check. If the network is available, the Service Worker checks for a newer
  version in the background and, if one exists, downloads and caches it without touching the active
  session. The new version never activates itself over a running session — see 6.3.
- **6.3 Update UX (lightweight, non-intrusive)** — ✅ Done. Once an update has finished
  downloading, a small, unobtrusive indicator appears in an existing status/version area — e.g.
  `v0.6.2 · Update ready ↑` or `Update ready · Reload` — and nothing else happens. No modal, blocking
  screen, forced reload, countdown, persistent nagging, or release-note popup on every deployment. If
  ignored, Draft Canvas keeps running on the current version indefinitely; the new version activates
  only on an explicit reload the user chooses, or a future clean start when it's safe to do so. This
  is the phase's central constraint: a deployment must never interrupt someone mid-explanation — no
  reload, reset, or disruption to an active canvas session just because a new version shipped.
- **6.4 Canvas schema versioning, independent of app version** — ✅ Done. A `schemaVersion` field
  on the canvas document, versioned separately from the Draft Canvas application version (e.g. app
  `v0.7` shipping alongside document `schemaVersion 4`, migrated up from `schemaVersion 3`).
  Migrations run locally, the same way import validation already does
  (`tests/import-validation.test.ts`) — an application update never requires uploading a diagram
  anywhere to be migrated. Backward/forward compatibility considered where practical, but the hard
  requirement is: no update path may let a new application version corrupt canvas data written by an
  older one.
- **6.5 Cache versioning & deployment safety** — ✅ Done. Hashed/versioned static assets, explicit
  application-shell cache versioning, stale-asset cleanup on activation, and Service Worker lifecycle
  management (install/activate/update) that avoids two application versions or schemas interacting
  unexpectedly during one session. Covers: partially downloaded deployments, failed update recovery
  (fall back to the last known working cached version whenever technically feasible — Draft Canvas
  should prefer being slightly outdated over unusable), multiple tabs open on different application
  versions at once, and avoiding an incompatible application/schema pairing ever loading together.
  "Atomic-enough" upgrades, not literal atomicity — the target is "never worse than what was already
  cached," not a formal transaction guarantee.
- **6.6 Persistent storage request (optional)** — ✅ Done. Where supported, request persistent
  storage via the Storage API (`navigator.storage.persist()`) to reduce eviction risk under storage
  pressure. Best-effort only, never a requirement — browser approval is optional, and nothing in the
  app should assume it was granted.
- **6.7 Installable PWA support** — 🧪 Exploratory, an optional extension of this phase, not a
  prerequisite for any part of it. Add to Home Screen / Install App, a manifest and app icon,
  standalone-window chrome, and better OS integration are worth revisiting later, but 6.1-6.6 must
  work from the normal Draft Canvas website with nothing installed. Building a large PWA project just
  to get offline support is the wrong shape for this phase — see the standing "PWA install" non-goal
  below, which this item stays consistent with rather than reopens.

**Storage caveat.** Cache Storage and IndexedDB are not permanent files on disk — browsers may evict
site data under storage pressure or browser-specific policy, with or without 6.6's persistence
request granted. That's an acceptable, intentional trade-off for a product that's deliberately a
*draft* tool, not a system of record — consistent with the "deliberately disposable when
appropriate" identity this phase reinforces. Existing export functionality (4.1, 4.2) remains the
durable escape hatch for a diagram someone cares about keeping. Never market this capability as
"works offline forever" — the accurate claim is **works offline after your first visit.**

**Architectural principle.**

```
                    Static Host
                        │
                 new versions only
                        │
                        ▼
                Service Worker
                        │
               cached application
                        │
                        ▼
┌──────────────────────────────────────┐
│             Draft Canvas             │
│                                      │
│ App shell/assets  → Cache Storage    │
│ Diagrams          → IndexedDB        │
│ Settings          → browser-local    │
│ Attachments       → browser-local    │
└──────────────────────────────────────┘

               NETWORK OPTIONAL
```

The network's job shrinks to three things: getting Draft Canvas for the first time, fetching newer
versions, and any explicitly network-dependent future feature. It's never required for everyday
drafting — Draft Canvas should increasingly behave like a local application that happens to be
delivered through a URL.

**Dependencies.** 0.1 (no-network invariant, extended from data to delivery), 0.3 (IndexedDB
persistence, already the home for canvas data under an offline shell), 4.1 (a static, self-contained
build output a Service Worker can cache wholesale). Independent of Phases 5, 7, and 8 — nothing here
needs Personalization, Contextual Learning, or the Command Surface to exist first, which is why it's
sequenced here by dependency rather than held behind them.

**Acceptance criteria.** A user who has loaded Draft Canvas once can go offline, refresh or reopen
the tab, and reach a working canvas with no error state and no time limit on how long they've been
offline. An in-progress session is never interrupted, reloaded, or reset by a background deployment.
A downloaded update is visible only as a small, ignorable indicator until the user reloads. A canvas
document from an older schema opens correctly under a newer application version, migrated locally. A
failed or partial update never leaves the app in a broken, uncached state — it falls back to the last
good cached version.

**What this will not become:** a requirement to periodically reconnect to remain usable, an offline
expiration window, a forced or auto-triggered reload on deployment, a modal or blocking update
screen, a countdown, persistent update nagging, release-note popups per deployment, a promise of
permanent storage, or a full PWA/install-first project. The goal stays narrow: refreshing Draft
Canvas without internet should not kill Draft Canvas.

## Phase 7 — Contextual Learning

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

- **7.1 Contextual hints & first-use coachmarks** — ✅ Done. Small, dismissible explanations tied
  to a specific canvas moment — the first Service node selected ("You can attach notes or code to
  this"), the first connector selected ("Connections can describe HTTP, events, callbacks, and
  other interactions"), an empty attachment slot on a node ("Add context → Note · Code"), and —
  since Phase 2.7 lets a note or code card attach to a *connector* just as it can a node, a
  capability easy to miss entirely — a connector with nothing attached yet, once its semantics hint
  is out of the way ("Drag a note or code card onto this connector to attach it as detail"). Each
  shown once, in place, never as a modal — and, deliberately, never as a *second* floating box
  either: since selecting a node or connector already opens `ElementInspectorPopover`/
  `EdgeInspectorPopover` (Phase 2), a hint is one small `HintStrip` folded into the top of that same
  panel rather than a competing overlay anchored at the same point.
- **7.2 Usage-inferred learning state** — ✅ Done. A hint retires the moment its behavior is
  demonstrated, not only when it's dismissed: attach a note or code card anywhere — a node or a
  connector — and every attachment-related hint never shows again, since it's the same underlying
  capability regardless of which kind of element taught it first; give a connector explicit
  semantics (an interaction type, a kind, a response toggle — anything that stamps the existing
  `semanticsOrigin: 'explicit'` field) and the connector-semantics hint stops. Pure state
  observation, not call-site instrumentation — no store had to learn about hints to make this work.
  An explicit dismissal (×) is the fallback, not the primary path. (The roadmap's original third
  example, "open the command menu once," isn't wired up — Phase 8's command surface doesn't exist
  yet; the same `retire(id)` API is generic enough for it to call into later with no redesign here.)
- **7.3 "New" feature indicators** — ✅ Done. A small dot badge on a newly discoverable
  capability — for something too minor to earn its own coachmark, this is the whole treatment. Ships
  with one real instance: the Learn Draft Canvas toolbar button itself carries the badge for anyone
  returning from an older version, until they notice it.
- **7.4 "Learn Draft Canvas" mode** — ✅ Done. An optional, user-triggered mode that resurfaces
  contextual explanations across the canvas for someone who wants a deliberate pass, rather than
  picking hints up incidentally. Triggered from a dedicated toolbar button (not `?`, which already
  opens the Keyboard Shortcuts sheet — reusing it would have meant moving that existing shortcut) and
  from a row inside that same Shortcuts sheet. Session-only, never persisted: nothing shows unless
  asked for, each time — this is the opt-in complement to 7.1's opt-out-by-default hints, not a
  second onboarding system.

**Guidance behavior, non-negotiable across all four:** contextual (tied to the moment, not a fixed
sequence), non-blocking, subtle, dismissible, shown only when relevant, shown once, remembered
locally, easy to rediscover manually (7.4) — and never shown during Presentation Mode. A hint
appearing mid-explanation is the one failure mode this phase exists to prevent; Presentation Mode
(3.2) is exactly where "the meeting" is happening.

**Persistence** reuses `src/lib/preferences.ts` (0.3) — which hints have already fired is a small,
local, non-document fact, the same shape as the existing theme preference, not a reason to
introduce a new store. Each hint is its own short `hint.<id>` key (`HintsProvider.tsx`,
`useHints.ts`, mirroring `PersonalityProvider`'s own Context+Provider pattern exactly); the "New"
badge tracks a single `last-seen-version` key plus one `feature-seen.<id>` per catalog entry
(`useNewFeature.ts`).

**Architecture:** small, reusable primitives — `HintStrip.tsx` (the hint itself), `HintsProvider`/
`useHints` (retirement state), `useIsNewFeature` (the badge) — not a generic tutorial framework. A
future feature that needs to introduce something new (4.3's export dialog, 5.1's background
setting) should reach for these same primitives rather than invent its own tooltip or walkthrough
system; this phase exists partly to make that the obvious default.

What this will not become: a forced walkthrough or multi-step product tour, a large welcome modal,
a tooltip that keeps reappearing after its feature is already learned, or documentation someone has
to leave the canvas to read. If an explanation needs more than a sentence, it belongs in `docs/`,
not in a hint.

## Phase 8 — Canvas Command Surface

*Purpose: a developer explaining something during a meeting should be able to keep talking while
operating Draft Canvas almost entirely from the keyboard — one fast, contextual surface instead of
a fourth place (after pointer, toolbar, side panel) to go looking for an action.*

**Product rationale.** Someone narrating "the API publishes this to Kafka…" shouldn't have to break
that sentence to go find the Queue preset, then break it again to find the connect gesture. The
purpose is speed, not magic: deterministic commands, not natural-language AI interaction — that's a
deliberate starting constraint, not a phase to graduate out of later. Think Linear, the VS Code
Command Palette, Raycast, Spotlight — contextual to a technical canvas — never a fake shell. A
primary UX built around typing `add-service --name payment-api` is novelty over usability and is
explicitly out of scope.

- **8.1 Command surface core** — ✅ Done. `⌘K`/`Ctrl+K` — and a quiet search button in the
  toolbar, carrying 7.3's "New" dot for returning users — opens a searchable list of deterministic
  commands with fuzzy matching: `db` surfaces "Add Data Store," `conn` surfaces "Connect to…,"
  `spot` surfaces "Spotlight selection," each with its existing keyboard chord shown beside it.
  `⌘K` only: `/` was considered and left free — one trigger, no accidental opens. The matcher is
  hand-rolled (`src/commands/fuzzy.ts`), not a dependency, because the short dependency list is
  part of the privacy promise. Every command is one call into an existing `editorStore`/`uiStore`
  action (`src/commands/registry.ts`); the palette itself (`CommandPalette.tsx`) owns only the
  query, the highlight, and — for a two-step command like "Connect to…" — the stage it is in.
  Available in Presentation Mode too, but navigation-only there: next/previous step, go to step…,
  fit, exit — never a mutating command mid-explanation.
- **8.2 Contextual commands** — ✅ Done. The list adapts to selection state instead of listing
  hundreds of unrelated actions: nothing selected surfaces creation, flows, and navigation; one
  node surfaces Connect to… (existing nodes by name, then "New Service/Data Store/Queue/Actor"
  which creates *and* connects, placed beside the source), Edit text, Spotlight, Start flow here
  (reusing 3.1 — immediate for one outgoing connector, a picker for several, absent for none),
  Duplicate, Bring to front/Send to back; one connector surfaces Change relationship…, Change
  kind…, async and response toggles, Reverse direction, Reconnect source…/target… (reusing 2.6),
  Add to flow…, Spotlight, Edit label; a multi-selection surfaces Group, Ungroup, Align (six ways),
  Distribute (three or more), Spotlight, Duplicate, Export selection… (reusing 4.1's own
  selection-only option). Creation commands stay available with a selection, and a created node
  is selected afterwards, so "Add Service → Connect to… → New Queue" chains without a mouse.
  Group for a *single* node was dropped — a boundary around one element isn't a thing 1.4 does.
  "Reverse direction" was the one operation that did not already exist; it was added to
  `document/operations.ts` as `reverseEdge` (endpoints and anchors swap, nothing else) with a
  store wrapper, so the palette still names an operation rather than owning one.
- **8.3 Canvas search & jump navigation** — ✅ Done. The same surface is the fastest way to find
  something on a large canvas — typing a name surfaces matching nodes, Flows, and labelled
  connectors under "Jump to," ranked alongside commands (an exact name beats a scattered command
  match; a good command match still leads) and capped at eight. Picking one pans there with the
  same capped bounds-fit Presentation Mode uses, selects it, and flashes it once (a `data-jump-flash`
  ring, static under reduced motion); picking a Flow selects its lens and frames its members. No
  separate search UI. Jump commands: next/previous step and go to step… (while presenting), fit
  canvas, fit selection. "Jump to bookmark" was not built — no bookmark concept exists in the
  model, and inventing one for a jump target would have been a feature, not a command.
- **8.4 Command history** — ✅ Done. An empty palette leads with "Recent" — the last few
  commands that still apply — so `⌘K` then `Enter` repeats the last one and `↓` browses the rest;
  a frequently repeated command (Add Service, Add Service, Connect, Connect during rapid diagram
  creation) rises a little in a typed search, with the nudge capped below a prefix match so it can
  never outrank the thing you just typed the start of. A two-step command records itself, not the
  target picked inside it; a jump is a place, not an action, and is never recorded. A small local
  list through `lib/preferences.ts` — one short key per slot (`command-recent.<n>`,
  `command-use.<id>`), never a joined value, because that file caps each at 64 characters — not a
  synced or cross-document history.
- **8.5 Quick-create shorthand** — 🧪 Exploratory. A lightweight, optional syntax for expert users
  (`+service Payment API`, `+db Ledger`) that never replaces normal command search. Handle with
  care: the shorthand accelerates direct manipulation on the canvas, it does not become a
  text-to-diagram DSL — `Payment API -> Repayment Events`-style chaining is explicitly the kind of
  thing that could tip Draft Canvas toward Mermaid, which is a standing non-goal.
- **8.6 Contextual action search on named elements** — 🧪 Exploratory. Commands that resolve against
  existing canvas object names — "Connect Payment API to Ledger," "Spotlight Repayment Worker,"
  "Show downstream from Checkout." Deterministic string matching against real node/Flow names, no
  LLM required — a genuine future direction, not a near-term commitment.
- **8.7 Command recipes** — 🧪 Exploratory. Small, reusable, user-triggered command sequences with
  sensible defaults — "HTTP Service" creates Service → External API, "Async worker" creates
  Queue → Worker with `consume` semantics (reusing 2.5's kind vocabulary). Templates the user
  invokes, never automatic architecture generation; not prioritized initially, but 8.1's command
  architecture should leave room for it rather than close it off.
- **8.8 Contextual right-click menu** — ✅ Done. A third invocation surface for the exact same
  commands 8.1-8.4 already expose — right-clicking a node, connector, junction, boundary,
  multi-selection, or empty canvas opens a small curated menu instead of the browser's own
  (`src/commands/contextMenu.ts` builds it from `nodeCommands`/`edgeCommands`/`multiCommands`, the
  same functions `commandsFor` calls, filtered to a hand-picked subset per target — never a
  parallel command catalog). Deliberately excludes any command whose `run()` can return a
  `CommandStage` (a follow-up picker, e.g. "Connect to…"), keeping it flat with no flyouts.
  Right-clicking an element already part of a multi-selection preserves the whole selection rather
  than collapsing to just the clicked one — resolved by snapshotting `editorStore.selection` on the
  right button's own `pointerdown` (capture phase), since React Flow's default click handling would
  otherwise collapse it first. Shift+F10/the Menu key open the same menu for the keyboard, anchored
  to the current selection's own center; nothing selected is a no-op. Also shipped alongside it:
  `attachToNode`/`attachToEdge` (already existed with zero UI call sites) wired to real "Add
  Note"/"Add Code" menu items; `descendantsOf` (already existed for boundary-drag-sweep) wired to a
  new "Select Contents" command; a new "Add Boundary" preset (shortcut `B`); `reverseEdge` fixed to
  re-infer an eligible edge's semantic after the swap, reusing `reconnectEdge`'s own
  `isEligibleForReinference` rule, so a reversed inferred edge relabels correctly (and an explicit
  choice still survives untouched); and the Inspector bar's own Distribute buttons corrected to the
  same ≥3-node gate the command already used (previously ≥2, silently a no-op at exactly 2).

**Architectural considerations.** Every command in 8.1-8.4 is a thin, deterministic front-end onto
an operation Phases 1-4 already expose (`document/operations.ts`, `document/flow.ts`, the export
pipeline) — the command surface should not grow a parallel way to mutate the document, only a
faster way to invoke the existing one. This keeps it instant, offline, and fully consistent with
0.1's no-network invariant: no command, including 8.6's name matching, ever leaves the browser.

**Dependencies & sequencing.** 8.1-8.4 depend only on Phases 1-4 already being real capabilities to
front — they could ship independently of Phase 5, 6, or 7. This phase was still sequenced after
Contextual Learning specifically for 8.1's own discoverability, and that is how it shipped: the
"Press ⌘K to act on this from the keyboard" tip is a fifth `HintStrip` id (`command-palette`) in
the same `ElementInspectorPopover` slot the node hints use, shown once an element's own hint is
learned or dismissed and retired the first time the palette opens (7.2's "open the command menu
once," finally wired); inline shortcut chips beside menu items reuse the app's `kbd` styling; the
toolbar button carries 7.3's "New" dot; the empty canvas and the Keyboard Shortcuts sheet each
gained a `⌘K` line. Built as 8.1 → 8.2 → 8.3 → 8.4, each gated before the next; 8.5-8.7 stay
exploratory and nothing in 8.1-8.4 scaffolds for them — `CommandStage` is the only extension point,
and it exists because 8.2 needed it.

**AI should not be required.** Every command listed above — create, connect, rename, group, align,
spotlight, flow, navigate, search, export — is deterministic. If AI capabilities are ever explored
for this surface later, they sit on top of this deterministic architecture, not in place of it; the
instant/offline/predictable core must keep working with AI turned off entirely.

**Acceptance criteria.** Opens and is typeable-in with no perceptible delay. Every 8.2 contextual
command is reachable with the keyboard alone, start to finish, with no mouse fallback required.
Fuzzy matching surfaces the intended command within the first few results for the abbreviations
above. No command makes a network request. Closing the surface without selecting a command leaves
the document exactly as it was.

**Connection to Intentional Roughness (5.2).** These two initiatives are meant to reinforce each
other, not ship in isolation: the command surface supplies the speed, 5.2 keeps the result from
feeling overly formal, and together they aim at one identity — a developer thinking out loud with a
keyboard and a whiteboard. For any decision inside either initiative, the test is the same one this
whole roadmap already applies: would this help a developer sketch or explain an idea without
interrupting the conversation? If it mainly helps someone produce a formal specification after
hours of solo editing, it belongs in another tool, not here.

## Phase 9 — Future / Experimental

*Purpose: named so they're not forgotten, not committed to.*

- **9.1 Longer-form export (MP4)** — 🧪 Exploratory. Worth revisiting only if a longer or
  higher-fidelity walkthrough than 4.3's GIF turns out to be genuinely needed. WebM stays out
  entirely unless a concrete need for it shows up — no reason to support it speculatively.

## Phase 10 — Support Draft Canvas

*Purpose: Draft Canvas is free and stays free — no artificial limits, subscriptions, locked
features, or watermarks, ever. This phase is the one deliberately small, entirely optional channel
for someone who wants to say "I use this thing, keep building it," without any part of the product
ever turning into a pitch for money.*

**Draft Canvas should earn support by being useful, not by making the free experience worse.** The
mechanism should feel like someone saying "I use this thing. Keep building it," never Draft Canvas
asking "please upgrade." This is intentionally the lowest-priority phase on the roadmap — worth
sequencing after the core experience (0-4) is mature enough that support would be a genuine, earned
reaction rather than an ask.

- **10.1 Support entry point & dialog** — ⬜ Planned (intentionally low priority). A subtle
  "❤️ Support Draft Canvas" line in the existing About dialog (`AboutDialog.tsx`) — one more
  low-key entry in the signature/links row that's already there, not a new surface. Selecting it
  opens a small dialog: *"Draft Canvas is free and independently built. If it helped you survive a
  meeting, explain an architecture, or avoid opening a heavier diagramming tool, you can optionally
  support its development."*
  - **Contribution options read as personalities, not tiers.** ☕ Kept me awake · 🍺 Survived the
    meeting · 🔥 Saved the architecture discussion · 🫡 Please keep building this shit — playful
    labels for different amounts, never presented as pricing rows.
  - **Contributing unlocks nothing.** No badges, no premium features, no raised limits, no
    preferential treatment, ever — stated in the dialog itself: *"No perks. No paywalls. Just
    support."* Whether someone has contributed isn't even something Draft Canvas has a way to know.
  - **Payment options stay minimal.** Philippines: a QR-based local payment option, ideally one
    interoperable QR rather than a wall of provider logos (Maya/GCash as fallback alternatives to
    evaluate only if a single QR solution doesn't hold up). International: PayPal. Two paths, not a
    payment-provider directory.
  - **Never intrusive.** No popups asking for money, no recurring banners, no reminders, no nag
    after an export, no guilt-driven copy, and — the hard constraint — no feature is ever gated or
    degraded to create a reason to contribute. The application must never get worse for a user who
    never opens this dialog.

**Architectural considerations.** This is link-outs, not a payment integration — the dialog opens
an external QR/PayPal link the same way the About dialog's existing GitHub/LinkedIn/email links
already do (`PRODUCT.links`), and Draft Canvas itself makes no request, tracks no click, and stores
no payment or contribution data anywhere. Fully compatible with 0.1's no-network invariant: nothing
about this feature runs inside the app's own network boundary — it just points somewhere else, the
same way a `mailto:` link already does.

What this will not become: a paywall, a subscription, a limits system, a badge or perk system, or
any messaging that implies the free version is lesser. If a future idea for this phase would make
Draft Canvas better for a payer than a non-payer in any way, it doesn't belong here.

## Standing non-goals

Unchanged, from `docs/ARCHITECTURE.md`'s "Deliberately not built": authentication, accounts, cloud
sync, collaboration, comments, AI generation, template libraries, provider icon packs, Mermaid
import/export, image nodes, PWA install. This roadmap doesn't revisit any of them, and nothing
above — including 5.1's background image — reopens that list.

**A note on 6.1-6.6 and "PWA install."** Phase 6 uses a Service Worker and Cache Storage to keep the
application shell available offline — that's an offline-availability capability, not an installable
one. It adds no install prompt, manifest-driven Home Screen icon, or standalone-window chrome, and
works entirely from the normal browser tab someone already has open. "PWA install" stays a non-goal
exactly as before; 6.7 names the installable-PWA idea explicitly and keeps it 🧪 Exploratory,
consistent with — not a reopening of — the standing list above.
