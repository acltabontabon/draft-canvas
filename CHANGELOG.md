# Changelog

All notable changes to Draft Canvas are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Draft Canvas is
currently in **alpha** (`0.x`) — expect things to move quickly, and version numbers to occasionally
break as we settle on a stable 1.0 shape.

## [Unreleased]

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

[Unreleased]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.0-alpha.2...main
[0.1.0-alpha.2]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/acltabontabon/draft-canvas/commits/v0.1.0-alpha.1
