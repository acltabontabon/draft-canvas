# Accessibility

On Windows and Linux, use `Ctrl` for `⌘` and `Alt` for `⌥`.

**Keyboard.** `⌘K` runs any command, `?` lists shortcuts, and `Shift+F10` opens the context menu (the
canvas menu when nothing is selected). See [keyboard shortcuts](keyboard-and-commands.md).
In **Appearance**, use `←` and `→` to switch tabs, or `Home` and `End` to jump to the first or last tab.
The canvas is one `Tab` stop: `⌥` + arrow keys move the selection, and the **Outline** reaches every
connector. Finishing a shape's name, or closing a toolbar or panel from the keyboard, puts focus back
on the canvas.

**Screen reader.** **Outline** (`⌥O`) shows the view as a tree of shapes, boundaries and connectors,
in sync with the canvas. Names, kinds, relationships and selection changes are announced. The
**Flows** panel is a tree too: arrows move between flows, and `→` and `←` open and close one onto its
steps.

**Touch and pen.** Tap to select, press and hold for the context menu, pinch to zoom. Handles,
buttons, menu rows and status bar controls are at least 40 px on touch screens.

**Contrast.** Shape outlines and connectors reach at least 3:1 in both themes, and interface text
4.5:1. Automated tests check both.

**Motion.** With the system's reduce-motion setting on, camera moves jump instead of animating, and
Outage notes and connector traces drop their movement.
