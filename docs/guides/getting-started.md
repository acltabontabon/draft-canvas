# Getting started

Draw a small order-processing system, present it, and export it.
Open the [web editor](https://app.draftcanvas.dev/) or [desktop app](desktop.md).
No account is needed.

Shortcuts use Mac keys. On Windows and Linux, use `Ctrl` for `⌘`.

## Start a canvas

Choose **Quick Draft** on Home for a blank canvas. To explore a finished diagram first,
choose **Try an example**, then **Play explanation**.

The web app saves locally as you draw. On desktop, press `⌘S` to save a Quick Draft as a file.

## Draw Service → Queue → Worker

1. Move your pointer over the canvas and press `S`. Type `Orders API`, then press `Enter`.
2. Drag from a dot on the service's edge into empty space. Choose **Queue**.
   Type `orders`, then press `Enter`.
3. A faint Worker suggestion appears beside the selected queue. Press `Tab` to accept it,
   then `Enter` to name it `Fulfilment worker`. If no suggestion is visible, press `]`.

[Preview the finished drawing.](../media/guides/service-queue-worker.png)

Connectors label themselves. Click one to change its relationship.
To connect existing shapes, drag from a dot on one shape onto the other.

## Add a note

Right-click the queue and choose **Attach note**. Write why the queue is there;
press `Esc` to keep the text. Click the note's chip to reopen it.

For a free-standing note, press `N`. Drag it onto a shape or connector and hold to attach it.

## Draw a boundary

Select the service, queue and worker, then press `⌘G` to group them in a boundary.
Press `Enter` to name it. Moving the boundary moves its contents too.

Choose a kind or colour in the boundary's toolbar. See [boundary kinds](shapes-and-connectors.md#boundaries)
for the options.

## Present a flow

1. Click the API-to-queue connector and choose **Add to flow**. Name it `Place an order`.
2. Click the queue-to-worker connector and choose **Add to Place an order**.
3. Open **Flows** (`F`) to check the order or edit step captions.
4. Click **Present** (`⌘Enter`). Press `→` or `Space` to advance, `←` to go back,
   and `Esc` to return to editing.

![The Flows panel with two ordered steps.](../media/guides/flows-panel.png)

The active step is highlighted, with its caption and attached notes.
The [presentation guide](flows-and-presentation.md) covers tracing, camera controls and multiple flows.

## Export it

Open **Export** (`⌘⇧E`) and choose:

| Choose | Use it for |
| --- | --- |
| **Image → PNG** | A slide or chat message |
| **Document → Editable** | A `.draftcanvas` file you can reopen or send |
| **Source** | A sequence diagram from your flow, or architecture source |

See [saving and sharing](saving-and-sharing.md) for backups, encrypted files and share links.

## Keep going

- Press `⌘K` to find a command, shape or [architecture starter](examples.md).
- Run **Arrange selection** to tidy selected shapes, or **Fit shapes to text** for shortened labels.
- Use [Look inside](depth.md) to draw detail inside a service.
- Add an [open point](open-points.md) to record an unresolved question.
- Press `?` for shortcuts.
