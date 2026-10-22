# Mark what is still open

Attach an **open point** to a shape, connector or boundary to record an unresolved question.
It adds a marker without changing the diagram's layout or relationships.

## The three kinds

| Kind | Use it for | Example |
| --- | --- | --- |
| **Tentative** | A working assumption | “This may need to be asynchronous.” |
| **Awaiting input** | An answer or review you need | “Confirm the interface with the owning team.” |
| **Parked** | A topic deliberately put off | “Revisit after the first release.” |

These are independent labels, not workflow stages. An unmarked element does not mean approved or verified.

## Raise one during the meeting

1. Select one or more elements. Multiple elements share one point.
2. Press `I`, or right-click → **Add open point…**.
3. Choose a kind and optionally add context.
4. Press `Enter` to close; `Shift+Enter` adds a line.

![Choosing an open-point kind beside a service.](../media/guides/open-point-raise.png)

Hover or focus a marker to preview it. Click to change the kind, edit context, **Resolve** or delete it.
For a shared point, **Not this one** detaches only that element. Several points on one element show a count.

## Come back to it

Click the open-point count in the status bar to list points across every room.
Choose a row to go to its element. **Focus open points** dims unmarked content;
**Exit focus** or `Esc` restores it.

![The Open points list.](../media/guides/open-point-review.png)

**Resolve** removes the marker and keeps the point in the list's collapsed resolved section.
You can add a resolution note, reopen it, or delete it. Nothing resolves automatically.

## Presenting and exporting

During presentation, click a marker to read it without editing.
PNG and SVG exports include markers and a key by default; untick **Open point markers** to hide them.
Editable files keep all points, including resolved ones. Sequence exports omit them.

## Good to know

- Deleting an element removes its attachment; a shared point stays on the other elements. Undo restores it.
- Copying a marked element creates a separate point for the copy.
- A point on a boundary concerns the boundary, not every shape inside it.
- An [AI agent](connect-an-ai-agent.md) can manage points when asked. Accepting a proposal does not resolve them.
