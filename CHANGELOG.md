# Changelog

All notable changes to Draft Canvas are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Draft Canvas is
currently in **alpha** (`0.x`) — expect things to move quickly, and version numbers to occasionally
break as we settle on a stable 1.0 shape.

## [Unreleased]

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

[Unreleased]: https://github.com/acltabontabon/draft-canvas/compare/v0.1.0-alpha.1...main
[0.1.0-alpha.1]: https://github.com/acltabontabon/draft-canvas/commits/v0.1.0-alpha.1
