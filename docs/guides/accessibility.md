# Accessibility

| Input | How |
| --- | --- |
| Keyboard | `⌘K` runs any command, `?` lists shortcuts, `Shift+F10` opens the context menu (the canvas menu, when nothing is selected). See [keyboard shortcuts](keyboard-and-commands.md). |
| Screen reader | **Outline** (`⌥O`) shows the view as a tree of shapes, boundaries and connectors, in sync with the canvas. Names, kinds, relationships and selection changes are announced. The **Flows** panel is a tree too: arrows move between flows, `→` and `←` open and close one onto its steps. |
| Touch and pen | Tap to select, press and hold for the context menu, pinch to zoom. Handles, buttons, menu rows and the status bar controls are larger on touch screens (at least 40 px). |

On Windows and Linux, use `Ctrl` for `⌘` and `Alt` for `⌥`.

- **Contrast:** shape outlines and connectors reach at least 3:1 in both themes; interface text
  reaches 4.5:1. Automated tests check both.
- **Motion:** with the system's reduce-motion setting on, camera moves jump instead of animating.
