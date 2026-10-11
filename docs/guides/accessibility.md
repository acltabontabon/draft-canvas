# Accessibility

Draft Canvas supports keyboard, screen reader, touch and pen use.

- **Screen readers.** Every shape is named ("Orders API, service") and every connector is read as a
  sentence in the arrow's direction ("Orders API writes to Orders"), the same words the canvas
  captions it with. Selecting announces what was selected once the selection settles. `⌥O` opens
  the **Outline**, the current view as a navigable tree beside the canvas, kept in step with the
  selection both ways.
- **Keyboard.** Everything reachable without a mouse: a letter drops a shape, `⌥`+arrows move the
  selection between shapes and along connectors, `⌘K` names every action, `Shift+F10` opens the
  context menu, `?` lists the rest. See [Keyboard shortcuts and the command palette](keyboard-and-commands.md).
- **Touch and pen.** Tap to select, hold for the context menu, two fingers to zoom; handles grow to
  finger size on a touch screen.
- **Contrast.** Shape outlines and connectors hold at least 3:1 against the canvas in both themes
  (`tests/theme-contrast.test.ts` computes it from the colour tokens), and small chrome text 4.5:1.
- **In CI.** `e2e/a11y.spec.ts` runs [axe](https://github.com/dequelabs/axe-core) over the Library,
  the editor, the export dialog, the command palette and the Outline, and fails on any serious or
  critical violation.
