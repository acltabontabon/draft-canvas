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
| [6](#phase-6--contextual-learning) | Contextual Learning | ⬜ Planned |
| [7](#phase-7--canvas-command-surface) | Canvas Command Surface | ⬜ Planned |
| [8](#phase-8--future--experimental) | Future / Experimental | 🧪 Exploratory |
| [9](#phase-9--support-draft-canvas) | Support Draft Canvas | ⬜ Planned (low priority) |

**What's next:** [Phase 6](#phase-6--contextual-learning). Phase 5 shipped both 5.1 (custom canvas
background) and 5.2 (Intentional Roughness), gated by the full test suite and browser verification.

## Product principle

> The user decides what connects. Draft Canvas decides how to make it look good.

> This is a draft. It should be allowed to look like one.

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

- **1.1 Shape vocabulary** — ✅ Done. Text, note, code, plus developer presets (service, database,
  queue, actor, group). Double-click to create — a small picker, no modal in the way. (The
  original Card shape and its unreachable `rounded` duplicate were removed in the hardening pass —
  see `docs/HARDENING.md` — since Note/Text/the developer presets already cover what a
  semantics-free box was standing in for.)
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
    any future MP4 per 8.1) preserve the active preset rather than reverting to Clean.

  What this will not become: cartoonish wobble, sketch textures that reduce legibility, hard-to-read
  hand-drawn fonts, randomized geometry, or a per-element style editor. If a diagram is harder to
  read in Draft or Sketch than in Clean, that's a bug, not a feature.

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

## Phase 7 — Canvas Command Surface

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

- **7.1 Command surface core** — ⬜ Planned. `⌘K`/`Ctrl+K` (and possibly `/` when the canvas is
  focused, echoing 1.7's existing single-key shortcuts) opens a searchable list of deterministic
  commands with fuzzy matching — `db` surfaces "Add Database," `conn` surfaces "Connect selected
  element," `spot` surfaces "Spotlight selection." No command requires memorizing an exact name.
- **7.2 Contextual commands** — ⬜ Planned. The list adapts to selection state instead of listing
  hundreds of unrelated actions: nothing selected surfaces creation and navigation (Add Service,
  Start Presentation, Find Element); one node selected surfaces Connect to…, Duplicate, Group,
  Spotlight, Start Flow Here (reusing 3.1); one connector selected surfaces Change Relationship,
  Reverse Direction, Reconnect Source/Target (reusing 2.6), Add to Flow; a multi-selection surfaces
  Group, Align, Duplicate, Export Selection (reusing 4.1).
- **7.3 Canvas search & jump navigation** — ⬜ Planned. The same surface is the fastest way to find
  something on a large canvas — typing a name surfaces matching nodes and Flows; picking one pans to
  it, briefly highlights it, and optionally selects it. No separate search UI. Includes jump
  commands (next/previous flow step, fit canvas, fit selection, jump to bookmark).
- **7.4 Command history** — ⬜ Planned. `⌘K` then Up Arrow recalls recently used commands; a
  frequently repeated command (Add Service, Add Service, Connect, Connect during rapid diagram
  creation) can rise toward the top. A small local list, not a synced or cross-document history.
- **7.5 Quick-create shorthand** — 🧪 Exploratory. A lightweight, optional syntax for expert users
  (`+service Payment API`, `+db Ledger`) that never replaces normal command search. Handle with
  care: the shorthand accelerates direct manipulation on the canvas, it does not become a
  text-to-diagram DSL — `Payment API -> Repayment Events`-style chaining is explicitly the kind of
  thing that could tip Draft Canvas toward Mermaid, which is a standing non-goal.
- **7.6 Contextual action search on named elements** — 🧪 Exploratory. Commands that resolve against
  existing canvas object names — "Connect Payment API to Ledger," "Spotlight Repayment Worker,"
  "Show downstream from Checkout." Deterministic string matching against real node/Flow names, no
  LLM required — a genuine future direction, not a near-term commitment.
- **7.7 Command recipes** — 🧪 Exploratory. Small, reusable, user-triggered command sequences with
  sensible defaults — "HTTP Service" creates Service → External API, "Async worker" creates
  Queue → Worker with `consume` semantics (reusing 2.5's kind vocabulary). Templates the user
  invokes, never automatic architecture generation; not prioritized initially, but 7.1's command
  architecture should leave room for it rather than close it off.

**Architectural considerations.** Every command in 7.1-7.4 is a thin, deterministic front-end onto
an operation Phases 1-4 already expose (`document/operations.ts`, `document/flow.ts`, the export
pipeline) — the command surface should not grow a parallel way to mutate the document, only a
faster way to invoke the existing one. This keeps it instant, offline, and fully consistent with
0.1's no-network invariant: no command, including 7.6's name matching, ever leaves the browser.

**Dependencies & sequencing.** 7.1-7.4 depend only on Phases 1-4 already being real capabilities to
front — they could ship independently of Phase 5 or 6. This phase is still sequenced after
Contextual Learning specifically for 7.1's own discoverability: "Tip: Press ⌘K from anywhere on the
canvas," and inline shortcut hints next to menu items, should be built as an instance of 6.1's
contextual-hint primitive, not a bespoke tooltip invented for this one feature — reusing Phase 6's
primitives is the point, the same way 4.3 reused Presentation Mode instead of building a second
animation system. Within the phase: 7.1 → 7.2 → 7.3 → 7.4 is the deterministic core and the
recommended build order; 7.5-7.7 stay exploratory and don't block it.

**AI should not be required.** Every command listed above — create, connect, rename, group, align,
spotlight, flow, navigate, search, export — is deterministic. If AI capabilities are ever explored
for this surface later, they sit on top of this deterministic architecture, not in place of it; the
instant/offline/predictable core must keep working with AI turned off entirely.

**Acceptance criteria.** Opens and is typeable-in with no perceptible delay. Every 7.2 contextual
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

## Phase 8 — Future / Experimental

*Purpose: named so they're not forgotten, not committed to.*

- **8.1 Longer-form export (MP4)** — 🧪 Exploratory. Worth revisiting only if a longer or
  higher-fidelity walkthrough than 4.3's GIF turns out to be genuinely needed. WebM stays out
  entirely unless a concrete need for it shows up — no reason to support it speculatively.

## Phase 9 — Support Draft Canvas

*Purpose: Draft Canvas is free and stays free — no artificial limits, subscriptions, locked
features, or watermarks, ever. This phase is the one deliberately small, entirely optional channel
for someone who wants to say "I use this thing, keep building it," without any part of the product
ever turning into a pitch for money.*

**Draft Canvas should earn support by being useful, not by making the free experience worse.** The
mechanism should feel like someone saying "I use this thing. Keep building it," never Draft Canvas
asking "please upgrade." This is intentionally the lowest-priority phase on the roadmap — worth
sequencing after the core experience (0-4) is mature enough that support would be a genuine, earned
reaction rather than an ask.

- **9.1 Support entry point & dialog** — ⬜ Planned (intentionally low priority). A subtle
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
