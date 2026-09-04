# Changelog

All notable changes to Draft Canvas are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Draft Canvas follows
`0.x` versioning until the shape settles — the `alpha`/`beta` releases below were pre-production
milestones; **0.1.0 is the first production-ready release.**

## [Unreleased]

### Changed

- The About dialog's support entry is now a single line — "☕ Buy the builder a coffee" — instead
  of an expandable section.

## [0.3.0] - 2026-09-04

### Added

- Added an optional way to support Draft Canvas's development — a subtle "♥ Support Draft Canvas"
  entry in the About dialog, never surfaced anywhere else.
- **Draft Canvas is more opinionated about what a connection probably means.** A Topic now reads
  as its own thing rather than just another Queue: Topic → Queue defaults to "fans out," Topic →
  Service to "delivers to," and each offers only the messaging interactions that make sense —
  no more sifting through HTTP, Query, or Reads/Writes for a message-broker connection. A
  database-to-database connection defaults to "ingests," with replicate/CDC/sync as alternatives,
  instead of the generic service-call list.
- **An unusual connection gets a gentle nudge instead of staying silent.** Connect a Queue directly
  to a Topic and Draft Canvas explains why that's atypical and offers a one-click "Insert Worker"
  fix — inserting a service between them and correctly relabeling both new connections — while
  still letting you keep the connection exactly as drawn if you meant it.
- A fresh Service → Service connection now shows a subtle "requests" caption instead of no label at
  all; picking a more specific interaction (HTTP, gRPC, Command, …) replaces it.
- **Right-click for a contextual menu.** Right-click a service, connector, junction, boundary,
  a selection, or empty canvas for a small menu of just the actions that make sense there —
  duplicate, layer, add a note or code snippet, reverse a connection, select everything inside a
  boundary, and more — each with its keyboard shortcut shown alongside it. The same menu opens
  from the keyboard too, with Shift+F10 or the Menu key.
- **Paste exactly where you click.** Right-click anywhere on the canvas and choose Paste to drop
  a copied selection precisely at that spot — handy for moving an architecture fragment into a
  different part of the canvas, or into a different diagram entirely.
- A boundary can now be added directly with the `B` key, alongside the other shapes.
- **Draft and Sketch look like genuinely different personalities now, not just more or less
  jitter on the same lines.** Draft stays restrained — tight corners, gently curved lines, a
  lightly hand-drawn arrowhead. Sketch goes further: databases, queues, and junctions get a
  retraced, doubled outline; boundaries draw with a bolder stroke whose corners deliberately
  overshoot, like someone circling part of the diagram; and every connector gets its own
  individually hand-drawn arrowhead instead of a stock one.
- The Personality setting (Canvas Settings → Personality) now shows a small live preview next to
  each option, so you can see the difference before choosing.

### Fixed

- Re-pointing a connector onto a different kind of node (say, a Database connection dragged onto a
  Topic) could leave it labelled with an interaction that no longer made sense there, with nothing
  to notice unless you happened to read it closely. It's now flagged with a one-click fix to
  relabel it correctly, without silently changing anything you chose on purpose.
- Reversing a connection's direction could leave it labelled with the wrong relationship (a
  reversed "writes" connector stayed labelled "writes" instead of becoming "reads"). It now
  relabels correctly, unless you had chosen the label yourself.
- A drop shadow could silently disappear from services, notes, code cards, and junctions the
  moment Draft or Sketch personality was active.
- A request/response connector's reply line didn't match its request line's hand-drawn look in
  exported files, even though it already did on the live canvas.
- A straight-routed connector never picked up any Draft/Sketch hand-drawn character at all.
- A settings dialog (Canvas Settings, Export, and others) could steal keyboard focus back to
  itself while you were still typing or adjusting a control inside it, if anything else on screen
  happened to update at the same time.
- Interrupting a resize or a connector drag — most commonly by switching into Presentation Mode
  before releasing the mouse — could leave undo unable to record your next several edits, with no
  visible sign anything was wrong.
- Pasting or duplicating a very large selection repeatedly, or into an already-large diagram,
  could grow it past the size a diagram can reliably stay responsive at. Draft Canvas now stops at
  that limit and tells you, the same way it already does for an imported file.
- Undoing a deleted Flow brought its connectors back but not which Flow's step badges were
  showing, or that you'd been presenting or editing it — you'd have to reselect it by hand. Undo
  now restores that too.

## [0.2.0] - 2026-09-04

### Added

- **Command palette.** Press `⌘K` (`Ctrl+K` on Windows/Linux), or use the search button in the
  toolbar, and type what you want to do — add a service, connect it, spotlight it, start a flow,
  present, export. The list changes with what you have selected, and two-step commands like
  "Connect to…" pick their target right there.
- **Find anything by name.** Type a node, flow, or connection name in the palette to jump to it.
- The palette remembers your recent commands, so `⌘K` then `Enter` repeats the last one.
- A connection can be reversed with "Reverse direction".
- A canvas that fails to render now shows a recoverable screen ("Something went wrong while
  rendering this canvas.") instead of going blank, with options to reload the canvas, restore the
  last saved version, or return to your diagrams.

### Fixed

- A rare interaction sequence involving a marquee (rubber-band) selection over a connector could
  crash the canvas to a blank screen. Fixed at the source rather than just contained.
- The app could get stuck indefinitely on "Opening local storage…" if reading your local diagrams
  failed on startup, with no error shown and no way to retry.
- Renaming, duplicating, deleting, or moving a diagram between projects could fail without telling
  you anything went wrong.
- Undo/redo could leave a flow selection, a flow-edit session, or Focus Mode referencing something
  that no longer existed in the restored diagram, with no way to get back out.
- Opening a diagram file whose format-version field was corrupted could skip the repair process
  that upgrades older files entirely, instead of running it.
- Malformed or hand-edited diagram files could slip a duplicate flow, a connection pointing a node
  at itself, or a reference to a project from a different browser profile past import.

## [0.1.2] - 2026-09-02

### Changed

- Connectors touching a Junction now expose the same interaction-type options (HTTP, Call, Async,
  Event, Command, Query, etc.) as any other connector, instead of hiding the Interaction section
  entirely. A Junction is treated as transparent routing: an outgoing connector's options and
  default follow whatever the Junction actually connects to on either side — inheriting a single,
  unambiguous incoming type as a (freely overridable) default, and falling back to the normal
  full picker when incoming types disagree or nothing feeds the Junction yet — while still
  respecting the same endpoint-compatibility rules as a direct connection.

## [0.1.1] - 2026-09-02

### Changed

- Selecting a flow now makes it stand out more clearly against the rest of the diagram: unrelated
  nodes, connectors, labels, and attachment chips dim further, while the selected flow's own nodes
  gain a subtle ring (the flow's colour, if it has one) and its connectors read slightly bolder.
  Attachment chips on connectors outside the selected flow now dim along with everything else,
  instead of staying at full opacity.

## [0.1.0] - 2026-09-02

The first production-ready release. Everything below `0.1.0` (`alpha.1` through `beta.2`) was a
pre-release milestone; this is the one meant for real use.

### Added

- Optional Projects for organizing diagrams once you have more than a handful: group canvases into
  flat, un-nested Projects from the homepage sidebar, or leave them Unorganized — nothing is ever
  required before creating a new canvas. Move a canvas into a project (or back out) from its row's
  folder icon; deleting a project moves its canvases back to Unorganized rather than deleting them.
- A homepage search box filters by diagram title and project name, and a sort control (Last edited,
  Created, Name) reorders the visible list — both entirely local, so the homepage stays usable once
  you have dozens or hundreds of diagrams instead of a handful.
- Copy (⌘C), cut (⌘X), and paste (⌘V) now work across diagrams, not just within one — select part
  of a diagram, open a different diagram, and paste it there. A copy only ever carries the
  connectors between elements you actually selected, so pasting never leaves a dangling connection
  to something left behind; every pasted element gets a fresh identity, positioned around your
  current view rather than wherever it started, and pasting the same thing again nudges each copy
  slightly so they don't stack exactly on top of each other.

### Changed

- Icon-only toolbar buttons (Undo, Redo, Present, Export, and others) now have a proper accessible
  name instead of relying on their tooltip alone.
- Flow rows in the Flows dropdown are now reachable and selectable by keyboard (Tab, then
  Enter/Space), not just by mouse.

### Fixed

- Typing a space into the diagram title (in the canvas toolbar, not the homepage rename dialog)
  was silently dropped — the title was committed to the document, and trimmed, on every keystroke,
  which deleted a space the instant it became the trailing character mid-sentence. The title field
  now edits locally and commits once you're done, like every other text field in the app.
- Opening a different diagram right after presenting one could carry Presentation Mode over,
  landing the new diagram straight into it with no editing chrome. Opening a diagram now always
  starts in edit mode.
- The connector/double-click type picker could render off-screen near a canvas edge, with no
  clamping to keep it on screen.
- The element and connector popovers could sit behind the toolbar once it wraps to two rows on a
  narrow window, instead of measuring its actual height.
- A contextual hint's dismiss (×) button did nothing while "Learn Draft Canvas" mode was on —
  Learn Mode's own "resurface hints you've already dismissed" behavior was overriding the
  dismissal on every render, so the hint stayed put no matter how many times you clicked ×.
  Dismissing a hint now always hides it right away and keeps it hidden for the rest of the
  session, without turning Learn Mode off. Also reworded the attachment hint copy ("Add context →
  Note · Code.") into a plain sentence explaining what it does.

## [0.1.0-beta.2] - 2026-09-01

### Changed

- Refreshed the shared-link preview image with a bigger brand mark and punchier copy calling out
  what Draft Canvas actually is — an opinionated, developer-focused canvas built for mid-meeting
  speed, not a generic diagramming app.

## [0.1.0-beta.1] - 2026-09-01

### Added

- Draft Canvas now works offline. After the first successful visit, refreshing or reopening the
  app with no internet connection loads normally from a cached app shell — your diagrams were
  already local (IndexedDB), and now the app itself is too. A newer version downloads quietly in
  the background when you're online and never interrupts a session in progress; a small
  "Update ready" indicator appears once it's safe to reload.
- Selecting a Service node or a connector for the first time now surfaces a small, dismissible
  explanation of what you can do with it — attach notes or code, describe HTTP/event/callback
  semantics — right inside the panel that selecting it already opens, instead of leaving those
  capabilities to be found by accident.
- Hints retire themselves once you've demonstrated the behavior they teach (attach something once
  and attachment hints stop; set a connector's semantics once and that hint stops), not only when
  dismissed by hand.
- A small "New" badge marks newly discoverable capabilities that don't warrant a full hint.
- An opt-in "Learn Draft Canvas" mode (toolbar lightbulb button) surfaces every contextual
  explanation across the canvas at once, for anyone who wants a deliberate pass instead of picking
  hints up incidentally.

## [0.1.0-alpha.4] - 2026-09-01

### Added

- Sharing the app's link now shows a title, a "For meetings that suddenly need a diagram." tagline,
  and a branded preview image in Slack, iMessage, and other link previews, instead of a bare URL
  with nothing else.

## [0.1.0-alpha.3] - 2026-09-01

### Added

- Actor now has three kinds — Human, System, and Device — each drawn with its own distinct glyph
  (a bust silhouette, a small system window, or a device outline) inside a shared, lightweight
  outlined card, instead of one generic head-and-shoulders figure with no container.
- Selecting a single shape now shows a compact, collision-aware popover anchored right at the
  shape (color, type, Focus, Delete), matching how selecting a connector already works. Multi and
  mixed selections keep the existing bottom bar.
- A connector's Interaction dropdown is now narrowed to what that specific pairing actually
  supports (e.g. Service-Queue only offers Publish/Event) instead of always listing every
  semantic.

### Changed

- Both the connector and element popovers show their full relevant editor as soon as you select
  something, instead of requiring an extra click on a "..." to reveal it.
- Database is now labeled "Data Store" throughout the UI (the underlying `database` type is
  unchanged, so existing diagrams are unaffected); its SQL/NoSQL/Cache subtype now reads as a
  quiet line under the primary label instead of a corner badge.
- Queue, Topic, and Stream now look visually distinct from one another (waiting/broadcast/flowing)
  instead of sharing one identical tube glyph.
- Actor is now sized and composed as a proper participant card — a large glyph filling most of
  the container with its name close beneath it — instead of a small icon lost in empty space.
- Data Store gets its own default footprint (narrower, taller) and a shallower cylinder cap,
  instead of inheriting the generic node size and reading as a stretched database icon.
- The generic "Circle" shape is now "Junction" — a compact routing/convergence point sized to read
  as punctuation in a diagram, not a component on par with Service or Data Store.
- A connector into or out of a Junction now shows a lightweight editor — label, flow membership,
  route, and style only — instead of the full Interaction editor (protocol, request/response,
  condition) built for connections between real components. Leaving a Junction, the label field
  is now framed as a branch label, since that's what a connector fanning out of a routing point
  almost always is.
- Dropdown menus (in the connector popover and elsewhere) now flip or shrink to stay clear of the
  viewport and the element they're editing, instead of sometimes covering it.
- Toolbar buttons now distinguish creation tools from utility actions, with a clearer active-tool
  state and ellipsis truncation for long titles; "Flows" is now visually separate from "Diagram"
  mode.

## [0.1.0-alpha.2] - 2026-08-31

### Added

- Export a Presentation Mode flow as an animated GIF — the same camera moves, connector pulse,
  and step-by-step highlighting you see on screen, dropped straight into a ticket or chat without
  reopening Draft Canvas.
- A compact flow switcher (`Flows · ⟨name⟩ ▾`) always visible in the toolbar, with "Diagram" as
  its own explicit state — press `F` to jump between flows without opening the full drawer.
- Selecting a flow now acts as a lens on the diagram: its connectors and nodes stay lit, everything
  else gently dims, with a brief one-time pulse when you switch — no need to enter Presentation
  Mode just to see what belongs to a flow.
- A contextual control anchored right at a selected connector, for editing its type, flow
  membership, and other details in place instead of from a panel docked at the bottom of the
  screen.
- A connector can belong to several flows at once, joined or left from a simple checkbox list on
  that same contextual control.
- An explicit "Editing: ⟨flow⟩" mode, entered deliberately from the flow switcher, for
  restructuring a flow's membership with the state clearly visible on screen.
- During Presentation Mode, click a connector's attachment indicator to reveal it as a temporary
  card — it collapses automatically on the next step unless you reveal it again.
- Flows can carry an optional accent color, shown only while that flow is the active lens
  (selected, or being presented) — existing flows are unaffected.
- A direct Service-to-Service connection now defaults to a synchronous request/response
  interaction — a solid request line with a quiet, dashed reply line — instead of a generic arrow,
  since that's what a direct service call overwhelmingly means. Every other shape pairing keeps
  its own sensible default.
- The connector popover is compact by default (type, flow membership, and a single "⋯"), with the
  full editor tucked behind "⋯" and grouped into clear Interaction, Request, Response, Route, and
  Style sections instead of one flat grid of controls. The connector's label is editable right from
  the compact row.
- Service-to-Service connectors get their own focused Interaction editor: a Protocol choice (HTTP
  or Generic Call) and a Mode choice (Sync or Async). HTTP splits its Request and Response into a
  method or status dropdown plus free text; Generic Call stays a single free-text field. Switching
  to Async hides the Response section — it isn't part of that interaction — without ever dashing
  the primary request line, since sync/async is a semantic choice, not a visual style.
- A small "//" marker appears directly on an async connector, on both horizontal and vertical
  routes, as a subtle at-a-glance cue for how a call happens — the label still says what happens.

### Changed

- A connector's attached notes and code now reveal on click instead of on hover, and open
  read-only first — a separate edit glyph switches to editing, so opening one to look at it no
  longer drops you straight into an editable text field.
- Double-clicking empty canvas with no tool armed now opens a type picker instead of instantly
  placing a shape, matching how dropping a connector on empty canvas already worked.
- Dropdowns inside the connector popover are now custom-styled controls consistent with the rest
  of the popover's chrome, instead of the browser's own unstyled native select menus.
- Request and response lines sit a little further apart, so a busy diagram with several
  request/response connectors reads as clearly separated pairs rather than a tight, crowded cluster.

### Removed

- The Card shape, and the never-user-facing `rounded` type it duplicated. Draft Canvas no longer
  has a generic, semantics-free box — Note, Text, and the developer presets already cover what a
  blank box was standing in for. Existing diagrams are unaffected: any Card on load becomes a Note,
  keeping its text, position, size, and color exactly as they were.

### Fixed

- A Queue (or Topic/Stream) in Presentation Mode's step breadcrumb, or in the Flow panel, showed
  as "Untitled" instead of its kind — a Queue has no editable name field at all, so the fallback
  that assumed blank text meant an unnamed node was always wrong for it.
- A request/response connector's reply line was rendered at an opacity too low to actually see
  against the canvas background, and — once fixed — sat too close to the request line and its
  label to read as two distinct things. Both now have proper contrast and spacing.
- Selecting a different connector while one of its popover's sub-panels (flow membership,
  connection type, ⋯) was open no longer leaves that sub-panel showing the *previous*
  connector's data — it now closes automatically on selection change, matching every other
  popover in the app.
- A response connector's label could render well below its own line instead of hugging it, because
  its position was nudged twice by two different spacing rules; it now derives directly from the
  reply line's own path.
- Two real edges sharing the same pair of shapes could interleave — a reply line drifting into the
  neighboring connector's lane instead of staying paired with its own request line.
- The connector popover could end up covering the very connection it was editing; it now measures
  itself and flips above or below to stay clear.
- Pressing Escape to close an open dropdown inside the popover's editor could close the whole
  editor panel instead of just the dropdown.
- The Generic Call request field rendered noticeably shorter than every other row in the editor;
  it now matches the height, padding, and type of the rest of the form.

## [0.1.0-alpha.1] - 2026-08-31

### Added

- A small, deliberate set of shapes to draw with: cards, text, notes, code snippets, and
  developer presets for services, databases, queues/topics/streams, actors, and groups.
- Drag from the edge of a shape to connect it to another — or drop on empty canvas and the shape
  you were heading for is created for you, already connected.
- Resize any shape freely.
- Group related shapes inside a labeled boundary (system, domain, network, or deployment).
- Focus Mode — highlight just the part of the diagram you're talking about, without hiding the
  rest.
- Syntax-highlighted code cards for Java, JSON, YAML, XML, SQL, shell commands, HTTP, and log
  output.
- Full keyboard shortcuts for drawing, undo/redo, copy, paste, and duplicate, plus a discoverable
  shortcuts reference.
- Connections that carry real meaning — pick a relationship (synchronous, asynchronous, event,
  callback, conditional, retry, failure, fallback) and Draft Canvas suggests a sensible color and
  default for you, always overridable.
- Labels that automatically sit on whichever side of a connection reads best.
- Attach a note or a code snippet directly onto a connection to add detail without cluttering the
  diagram.
- Drag an existing connection to reconnect it elsewhere, with a live preview as you drag.
- Flow storytelling — turn a diagram you've already drawn into a named, ordered, step-by-step
  narrative, and build as many flows over the same diagram as you have scenarios to explain.
- Presentation Mode — step through a flow one connection at a time, with the active path lit up
  and everything else quietened, not hidden.
- Conditional branches, callback/response arrows, and dedicated steps that can spotlight a whole
  group of shapes or a specific view of the canvas.
- Export your diagram as a native Draft Canvas file, an SVG, or a PNG — pixel-identical to what
  you see on screen.
- Password-protected encrypted export and import, for sharing a diagram securely outside your
  device.
- Everything autosaves as you work, with full undo/redo history.
- Fully local and private by design — no accounts, no cloud sync, nothing you draw ever leaves
  your device. Documents are encrypted at rest in your browser.

[Unreleased]: https://github.com/acltabontabon/draft-canvas/compare/v0.3.0...main
[0.3.0]: https://github.com/acltabontabon/draft-canvas/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.0-beta.2...v0.1.0
[0.1.0-beta.2]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.0-alpha.4...v0.1.0-beta.1
[0.1.0-alpha.4]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/acltabontabon/draft-canvas/commits/v0.1.0-alpha.1
