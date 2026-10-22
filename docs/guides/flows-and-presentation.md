# Flows and presenting

A flow is an ordered list of connectors. Use it to explain what happens, one step at a time.

Shortcuts use Mac keys. On Windows and Linux, use `Ctrl` for `⌘`.

## Trace a flow

1. Open **Flows** (`F`, the glyph beside **Present** at the top right) and choose **Trace a flow**, or
   find it in `⌘K`.
2. Name the flow and click connectors in the order you want to explain them.
3. Choose **Finish** to save the trace as one undo step.

Use **Remove last** (`Backspace` outside a text field) to undo a provisional step.
**Cancel** or `Esc` discards the trace. **Trace more steps** appends to an existing flow.

You can pan and zoom while tracing. For keyboard selection, open **Outline** from the tracing bar,
navigate to a connector, and press `Enter`. For a shared line, pick its connector in the tracing bar.
Leaving the diagram or level, or an outside edit, cancels an unfinished trace.

## Build a flow one step at a time

Click a connector and choose **Add to flow**. Name the new flow, then click another connector
and choose **Add to <flow name>**. Repeat for each step.

![The Flows panel with two steps in Place an order.](../media/guides/flows-panel.png)

In **Flows**:

| Action | Use it to |
| --- | --- |
| **Move earlier / Move later** | Reorder a step |
| **Remove step** | Remove it from the flow |
| **New flow** | Tell another story using the same diagram |
| **Rename** (`F2`) / **Delete** | Manage the selected flow |
| **Spotlight extra shapes** | Include selected shapes in a step's highlight |
| **Pin the camera** | Keep the current view for a step |

Edit a step's caption in its connector popover. Deleting a connector removes its steps too;
Undo restores both.

## Present

Click **Present** (`⌘Enter`). If several flows have steps, choose one.
The opening shows the whole path; advance to begin.

![A presentation step highlighting its connector and showing the queue's note.](../media/guides/presenting.png)

| Key | Action |
| --- | --- |
| `→` / `Space` | Advance through opening, steps, closing and the next flow |
| `←` | Go back |
| `Home` / `End`; `1`–`9` | First / last step; jump to a step |
| `Shift+→` / `Shift+←` | Next / previous flow |
| `Shift+F` | Choose a flow |
| `O` | Toggle the whole-flow overview without losing your step |
| `R` | Re-centre and resume guided camera movement |
| `P` | Toggle the pointer ring |
| `⌘↓` / `⌘↑` | Look inside a selected shape / go back out |
| `Esc` | Close a reveal, then leave presentation |

Each step highlights its connector and destination, with its caption and attached notes.
Click an open-point marker to read it. Pan or zoom freely; guided framing resumes only after **Re-centre**.

For a long caption, choose **Read full step details** and scroll with `↑`/`↓`, `Page Up`/`Page Down`
or `Space`. Left and right arrows still change steps.
Leaving presentation restores your editing view and selection.

## Export a flow as a sequence diagram

Open **Export → Source** (`⌘⇧E`), choose flows, then **Mermaid** or **PlantUML**.
Copy the text or download it for a README or wiki. Each playable flow becomes a sequence diagram;
nested levels are included.

Messages follow who acts: `Database → Worker: read by` exports as the worker reading the database.
Async calls and replies are kept; open points are omitted.
For an image with numbered connectors, select the flow and export **Image**.

See [saving and sharing](saving-and-sharing.md) for file and link options.
