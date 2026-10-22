# Accessibility

Use the keyboard, a screen reader, touch or pen to work with a diagram.

| Input | How to use it |
| --- | --- |
| Keyboard | `⌘K` opens commands; `?` lists shortcuts; `Shift+F10` opens the context menu. |
| Screen reader | Open **Outline** with `⌥O` to navigate shapes, boundaries and connectors as a tree. Selection stays in sync with the canvas. |
| Touch / pen | Tap to select, hold for the context menu, and use two fingers to zoom. Handles enlarge on touch screens. |

On Windows and Linux, use `Ctrl` for `⌘` and `Alt` for `⌥`.
Screen readers announce shape names, kinds, relationships and selection changes.

Both themes use at least 3:1 contrast for shape outlines and connectors, and 4.5:1 for small UI text.
The contrast checks and axe browser checks are in `tests/theme-contrast.test.ts` and `e2e/a11y.spec.ts`.

See [keyboard shortcuts](keyboard-and-commands.md) for drawing and navigation controls.
