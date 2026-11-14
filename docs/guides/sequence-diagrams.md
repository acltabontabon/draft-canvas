# Sequence diagrams

A **sequence** shows behaviour over time: who says what to whom, in what order, and under which
condition. It is one element on the canvas, beside your architecture, and it lays itself out. You
say who takes part and what happens; you never place a lifeline, size an arrow or draw a frame.

![A sequence with four participants, a call chain, replies and an optional part.](../media/guides/sequence-diagram.png)

## Start one

Press `L`, or click **Sequence** on the toolbar and then the canvas. The first participant is
already waiting for its name.

1. Type a name and press `Enter`. The next participant opens beside it.
2. Repeat for each participant, then press `Esc` on the empty one.

![Naming a participant: the list offers what it could be.](../media/guides/sequence-participants.png)

The list under the name offers what the participant could be. A plain `Enter` takes the marked
one; the arrow keys choose another:

- **A shape already on the canvas** with that name. The participant then stands for it
  ([see below](#use-shapes-from-your-architecture)).
- **A technology** the name matches. "Kafka" is a topic with its logo; "PostgreSQL" a data store.
- **A kind of shape**: Service, Actor, Data Store, Queue or Component.

The head shows the choice before you make it.

## Add messages

Drag from one lifeline to another, then type what the message says. The row where it will land is
shown while you drag.

- Drag past the last lifeline to add a participant with the message.
- Drag away and back onto the same lifeline for a message to itself.
- Hover between two participants and click **+** to add one there. The others make room.

With the keyboard, `Tab` adds the message that usually comes next, shown faintly below the
selection; `]` and `[` offer others (a reply, an onward call, a call to itself).

![The next message offered after a call.](../media/guides/sequence-next.png)

A call starts work on its receiver, drawn as a bar on the lifeline. **Add reply** puts the reply
below whatever that call set going, and ends the bar. Nothing is added that you did not ask for:
a reply is never inserted on its own.

## Select and change

Click a participant, message, note or frame to select it; `Shift`-click extends the selection.
What you can do appears beside it and nowhere else.

| Selected | You can |
| --- | --- |
| Participant | Rename, change its shape, kind or technology, link or unlink a shape, group, delete |
| Message | Edit, make it a **Call**, **Asynchronous**, **Reply**, **Create** or **Destroy**, reverse it, turn its work bar on or off, add a reply or a note, duplicate, delete |
| Several messages | **Wrap in…** a condition, optional part, loop, parallel branches, break or critical section |
| Frame or branch | Change its kind, edit the condition, add, move or remove a branch, unwrap, delete |
| The sequence | Rename it, add a participant or a reference, present it |

The right-click menu and `⌘K` offer the same commands.

- **Reorder** by dragging a message or frame up or down, or a participant sideways. A move that
  cannot be right (a reply above its call, a message to something not yet created) is refused, and
  says why.
- **Asynchronous** is suggested, never assumed, where the receiver is usually sent to without
  waiting (a queue or topic). One click applies it.
- **Create** starts the receiver's lifeline at that message; **Destroy** ends it.
- A problem in the order (a reply with no call, a message after its participant ended) is marked
  with a small warning on its row. Select it to read what is wrong.

### Conditions, loops and parallel branches

Select the messages that belong together and choose **Wrap in…**.

![Two messages selected, with the kinds of frame they can be wrapped in.](../media/guides/sequence-wrap.png)

| Frame | Means |
| --- | --- |
| **Condition** (`alt`) | One of several branches happens, each under its own condition |
| **Optional** (`opt`) | Happens only when the condition holds |
| **Loop** | Repeats while the condition holds |
| **Parallel** (`par`) | Branches that run at the same time, in no order |
| **Break** | If this happens, the rest is skipped |
| **Critical** | Must not be interleaved with anything else |
| **Reference** | Stands for another interaction, named but not drawn here |

Type the condition and press `Enter`. **Add branch** adds an *else* (or another parallel branch).
`Delete` on a frame removes the frame and keeps its messages; **Delete with its messages** removes
both.

### Notes and groups

**Add note** puts a note beside the selected message, over one or two participants.
`Shift`-click several neighbouring participants and choose **Group** to draw them under one name
(a subsystem, a team). A group says only that they belong together.

## Use shapes from your architecture

Drag a shape from the canvas over a sequence and rest it between two participants.

- A shape **that is part of a diagram** (connected, in a boundary, annotated or in a flow) stays
  where it is. The participant *stands for* it: rename either one, or change its kind, technology
  or colour, and the other follows. A small link mark shows on the participant.
- A shape **on its own** moves into the sequence. Nothing is left behind on the canvas.

A shape tool or key used over a sequence (`S`, `D`, `Q`, `A`, `M`, or a toolbar button) adds a
participant of that kind there.

With architecture shapes selected, `⌘K` → **Sequence from these** starts a sequence beside them
with one linked participant each, left to right. It adds no messages: order is never guessed from
connectors. **Unlink** on a participant lets the two go their own way. Deleting the shape keeps
the participant.

A [flow](flows-and-presentation.md) has an order you already gave it. `⌘K` → **Draw the flow as a
sequence** draws it beside the diagram, with participants that stand for the flow's shapes.

## Keyboard

`⌘↓` steps into the selected sequence; `Esc` steps back out.

| Key | Action |
| --- | --- |
| `⌥` + arrow | Move the selection to the next participant or message |
| `⌥⇧` + arrow | Extend the selection |
| Arrow | Move the selected message up or down, or the participant left or right |
| `Enter` or `F2` | Edit |
| `Tab`, `]` / `[` | Add the offered message; offer another |
| `P` | Add a participant after the selected one |
| `⌘D` | Duplicate |
| `⌘G` / `⌘⇧G` | Wrap messages or group participants / unwrap or ungroup |
| `Delete` | Delete; on a frame, unwrap |

## Present

Select the sequence and choose **Present this sequence** (also in `⌘K` and the right-click menu). It plays one
message at a time with the same keys as a [flow](flows-and-presentation.md#present): what has been
said stays, what is being said is lit, and the caption names the condition or branch it is in.

## Export and import

- **Images** (PNG, SVG) show a sequence as drawn.
- **Share → Export → Other formats → Sequences** writes each sequence, and each flow, as
  **Mermaid** or **PlantUML**, with its conditions, loops, work bars and groups.
- Paste or import a Mermaid `sequenceDiagram` to get an editable sequence. Anything it uses that
  is not drawn is listed. See the [Mermaid import reference](../reference/mermaid-import.md#sequence-diagrams).
- An [AI agent](connect-an-ai-agent.md) can add, read and change sequences when asked.

## Good to know

- A sequence is one shape on the canvas: move it, put it in a boundary, connect to it, copy and
  paste it, attach notes and [open points](open-points.md) to it. Resize it for more room; it
  never gets smaller than what it holds.
- Undo and redo work inside it. Naming a new participant or message is one step.
- Mermaid has no reference frame; one is exported as a note.
- draw.io export shows a sequence as a labelled box.
- While [collaborating live](collaborating.md), two people changing the same sequence at the same
  moment keep the later change; changes to different shapes never conflict.
- Copying a single message to the clipboard is not available; **Duplicate** is.
- A flow step can light a whole sequence, not one of its messages.
