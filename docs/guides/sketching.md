# Sketch and Smart Ink

The **Pencil** draws over a diagram: circle a service, underline a risk, scribble a note during a
review. **Smart Ink** turns rough boxes, cylinders and arrows into real shapes and connectors as
you draw them.

Pick up the Pencil beside **Select** in the toolbar, or press `P`. The toolbar turns into the
Pencil's: its tools take the place of the shapes until you put it down.

| Tool | For | Key |
| --- | --- | --- |
| **Sketch** | Freehand ink that stays exactly as drawn | `P` |
| **Smart ink** | Rough shapes and arrows that become real ones | `P` again switches |
| **Highlight** | A broad, see-through marker | `H` |
| **Erase** | Drag across a stroke to take it away | `E` |

Choose an ink and a width beside them. **Select** or `Esc` puts the Pencil down and brings the
shapes back.

Draw with a mouse, a pen or a finger. A stylus draws with pressure, and its eraser end erases. Once
a stylus has touched the canvas, a finger pans instead of drawing, so a resting hand leaves no
marks. The wheel, a pinch and the middle mouse button still pan and zoom while the Pencil is in
hand.

## Sketches

A sketch is annotation, not architecture. It never moves, connects or changes the shapes under it,
and routing, Arrange, Tidy up and agents ignore it.

With **Select**, click a stroke to choose it (`Shift`-click for more), drag to move it, and press
`Backspace` to erase it. A marquee picks up the strokes inside it. Right-click a stroke for
**Convert to shape** and **Erase stroke**.

Sketches belong to the view they were drawn in. Each shape's inside view keeps its own. A view
holds sketches only while it holds a shape, so draw a shape there first.

## Smart Ink

Draw roughly; the Pencil waits a moment after you lift it, so you can finish a box in several
strokes or add an arrowhead.

| You draw | It becomes |
| --- | --- |
| A box | A **Component**: offered as a Service, Boundary or Note too |
| A large box in empty space | A **Boundary** |
| A box around shapes | A **Boundary** that holds them |
| A cylinder (an oval on top, then the sides and bottom) | A **Data Store** |
| A tube on its side | A **Queue** |
| A circle | A **Component**, or a **Junction** when small |
| A stick figure | An **Actor** |
| An arrow from one shape to another | A connector, pointing where you drew it |
| A line from one shape to another | A plain connector, without an arrowhead |

The shape takes the size you drew. A strip beside it shows what it became and what else it could
be:

- **←** / **→** or a number changes it in place.
- **Enter** keeps it and starts its name.
- **Esc** or **Keep sketch** puts your drawing back.
- Drawing on keeps it as it is.

Anything else stays ink, exactly as drawn. That includes a circle around shapes (pointing at them),
a mark over or across a shape, a line ending in empty space, an underline, handwriting and
scribbles. A drawing that is close to a shape but not clear enough is only offered: the strip
appears with **Make it** and nothing changes until you choose.

Undo takes a converted shape or connector back to your strokes; undo again removes the strokes.
Choosing a different kind in the strip doesn't add an undo step.

Smart Ink only reads geometry. A box is a Component, not a microservice; it never guesses a
technology, protocol or responsibility. Recognition runs on your device with no AI model or
network. Connectors drawn as arrows get the same suggested relationship a dragged connector does.

## Convert later

Choose sketch strokes, then right-click → **Convert to shape** or `⌘K` → **Convert to shape**. The
same recognition runs; when nothing is recognised, the strokes stay and you're told so.

## Saving, exporting and sharing

- Sketches are saved with the diagram and come back when you reopen it.
- PNG and SVG exports draw them over the diagram, as on the canvas. A selection-only export leaves
  them out.
- Mermaid, PlantUML and other text exports have no way to show handwriting and leave sketches out.
- In a live session, collaborators see each stroke once it is finished, not while it is drawn.
- Older versions of Draft Canvas can't open a file with sketches; they say so rather than open it
  without them.

## Limits

A file holds up to 4,000 strokes. Very long strokes are simplified to 2,000 points. Recognition
expects roughly straight arrows; a curved arrow stays ink.
