# Getting started

In a few minutes you'll draw a small system, annotate it, walk someone through it, and export
it. The system is an API that puts orders on a queue for a worker to process.

You need the app open: the [hosted version](https://acltabontabon.com/draft-canvas/editor/), a
[Docker copy](../../README.md#running-it-yourself), or the
[VS Code extension](vscode.md). Nothing here needs an account, and nothing you draw leaves your
browser.

Shortcuts are written for a Mac. On Windows and Linux, read `⌘` as `Ctrl`.

## Start a canvas

On the first visit, choose **New canvas** (pressing `Enter` also works). Later, the same **New
canvas** button is at the top of the Library, the list of your saved diagrams. Your diagram
saves itself as you work; see [Saving, backing up and sharing](saving-and-sharing.md).

## Draw Service → Queue → Worker

1. **Add the service.** Move your pointer over the canvas and press `S`. A Service appears under it,
   ready to type. Type `Orders API` and press `Enter`.
2. **Add the queue.** Select the service and drag from one of the small dots on its edge (its handles) into empty
   space, then let go. A short menu offers Service, Data Store, Queue and Actor. Choose **Queue**,
   press `Enter` to name it, and type `orders`.

   ![Dragging a connector from Orders API into empty space opens a menu offering Service, Data Store, Queue and Actor.](../media/guides/quick-connect.png)

3. **Take the suggestion.** With the queue selected, a faint Worker appears beside it, connected. That
   is Draft Canvas guessing your next move from what you've drawn. Press `Tab` to accept it, then
   `Enter` to name it `Fulfilment worker`. If the guess isn't what you want, press `Esc`, or `]` to
   see another.

   ![A faint Worker shape and a dashed connector labelled "consumed by" appear next to the selected queue, with a small pill reading "Worker" and "Tab".](../media/guides/suggestion.png)

The connectors have labelled themselves with what they mean. The line from the API to the queue
says it *publishes to* it, and reads in the direction the arrow points. To change one, select the
connector and pick another relationship from its popover; only those that make sense for that pair
are offered. Nothing stops you drawing something unusual on purpose.

Pointing at a connector highlights it faintly and marks its two ends, so you can see which one a click
will select; click anywhere along its line, or on its arrowhead. When several connectors leave a shape
along the same line with the same label, the label is shown once on the stretch they share. Click it to
select one of them, and click again for the next.

![Orders API, a queue called orders and Fulfilment worker in a row. The connectors are labelled "publishes to" and "consumed by".](../media/guides/service-queue-worker.png)

Some other ways to draw the same thing:

- Press `⌘K`, type `queue`, and press `Enter` to add a Queue from the palette.
- Type a letter for other shapes: `D` Data Store, `A` Actor, `B` Boundary, `N` Note. `?` lists them all.
- Select a shape, press `⌘K`, and choose **Connect to…** to wire it to another shape without the mouse.

## Add a note

Notes are for what the boxes don't say: why the queue is there, or a decision the room just made.

1. Press `N` to drop a note and type into it. `Enter` starts a new line; `Esc` keeps what you typed.
2. Drag the note onto the queue and hold it there until it docks. It collapses to a small chip on the
   shape, and clicking the chip opens the note. You can dock a note on a connector the same way.

![The queue now carries a small chip in its top corner, marking the attached note.](../media/guides/note-docked.png)

Or right-click a shape and choose **Add Note**, which creates one already attached.

## Present a flow

A flow is a numbered path through connectors. It's how you say "first this happens, then this".

1. Click the connector from `Orders API` to `orders`. Its popover opens, with an **Add to flow** tab at
   the top. Click it. That starts a new flow with this connector as step 1 and opens the Flows panel
   with the name selected, so type `Place an order` and press `Enter`.

   ![A connector's popover with two tabs at the top: "publishes to" and "Add to flow".](../media/guides/add-to-flow.png)

2. Click the next connector, from the queue to the worker, and choose **Add to Place an order** in the
   same place. It becomes step 2.
3. The **Flows** panel (the **Flows** button in the toolbar, or `F`) lists the steps. Use it to reorder,
   rename, or remove them.

   ![The Flows panel listing "Place an order" with two steps, and numbered badges on the two connectors.](../media/guides/flows-panel.png)

4. Click **Present** in the toolbar. The editor gets out of the way and the flow starts at step 1.
   Press `→` or `Space` for the next step and `←` to go back. `Esc` returns to editing. `⌘Enter`
   does the same as the button.

While a step is showing, the notes attached to what it shows appear beside it. The note on the queue
appears when the flow first reaches the queue.

![Presenting step 1 of 2: the first connector is highlighted, the rest of the diagram is faded, and the queue's note appears above it.](../media/guides/presenting.png)

If you have more than one flow, Draft Canvas asks **Present which flow?** first.

## Export it

Press `⌘⇧E`, or open **Export** in the toolbar.

![The Export dialog with Image selected: PNG, a Light palette, and a preview of the diagram with the file name order-processing.png.](../media/guides/export-image.png)

- **Image → PNG** for a slide or a chat message. Choose the **Light** palette for a document, or tick
  **Transparent** to lay it over your own background.
- **Document → Editable** saves a `.draftcanvas` file you can reopen later, send to someone, or commit
  to a repository.
- **Source** turns your flow into a Mermaid or PlantUML sequence diagram, as plain text you can paste
  into a README or wiki.

The [saving guide](saving-and-sharing.md#export-a-file) covers each option, including encrypted
exports.

## Where next

- **Skip the blank page.** Press `⌘K` and type `microservices`, `cqrs` or `saga`: a starter fills the
  canvas with a composed architecture you edit like anything else.
- **Show more or less detail.** [Explain a system at different levels](depth.md) uses **Look inside**
  to keep the overview clean and draw the detail one level down.
- **Go faster.** [Keyboard shortcuts and the command palette](keyboard-and-commands.md).
- **Ask the app.** **Learn Draft Canvas**, in the toolbar's More menu, has short animated recipes for
  each of the moves above.
