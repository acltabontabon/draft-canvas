# Shapes, connectors and boundaries

Draft Canvas knows what its shapes are. A Queue is not a rectangle with a caption: it is something a
Service publishes to and a Worker consumes from, and the connectors between them say so without you
typing it. This guide is about using that: picking the right kind of shape, saying what an arrow
means, showing the reply, and marking the failure path.

Shortcuts are written for a Mac. On Windows and Linux, read `⌘` as `Ctrl`.

## Pick the right kind

Every architecture shape has a **kind**, one step sharper than the shape. Select a shape and choose it
from the bar that appears; the silhouette changes so the kind can be read from across the room.

| Shape (key) | Kinds |
| --- | --- |
| Service (`S`) | Service, API, Worker, External System, Scheduler, Gateway |
| Data Store (`D`) | Database, SQL, NoSQL, Cache, File system, Object storage, Search index, Table |
| Queue (`Q`) | Queue, Topic, Stream |
| Actor (`A`) | Human, System, Device, Group, Third Party |
| Component (`M`) | Component, Module, Adapter, Port |

The kind decides which relationships the shape can have. A Service writes to a Database and
*invalidates* a Cache; a Topic *fans out* to queues and a Queue is *consumed by* a worker. The full
table is in [Architecture semantics](../reference/semantics.md#the-capability-matrix).

An **External System** is a Service you don't own: a payment provider, an email service. It carries an
EXTERNAL caption and takes the same connectors a Service does.

## Say what the arrow means

Drag from a shape's handle onto another shape to connect them. The connector labels itself with the
most likely relationship for that pair, reading in the direction of the arrow: `Orders API`
*publishes to* `orders`, and `orders` is *consumed by* `Fulfilment worker`.

To change it, click the connector. Its popover lists only the relationships that make sense for those
two shapes, with the current one marked. Nothing stops you drawing something unusual on purpose: a
pairing the matrix has an opinion about shows a small ▲ and still offers *depends on*.

## Sync, async and the reply

Between two Services, the popover's **Interaction** section chooses the protocol (**HTTP** or a
**Generic Call**) and the mode:

- **Sync** draws a solid line: the caller waits.
- **Async** draws a dashed line with a break mark: the caller carries on. Right-click a connector and
  choose **Make asynchronous** to toggle the same thing without opening the popover.

Turn **Response** on to draw the reply coming back along the same connector, with its own text
(`200 OK`, `order accepted`). **Guess** fills in a sensible status for the protocol. An asynchronous
call has no response line; switching a connector to Async removes it.

## Put a note or payload on a connector

Notes and Code shapes dock onto connectors the same way they dock onto shapes: drag one over the
line and hold until it snaps into a chip. Use a Code chip for the payload or the message schema, and
a Note for why the call is there. Click the chip to read or edit it; drag it off to make it a
free-standing shape again.

Right-click a connector for the same two, created already docked.

## Mark the failure path

A queue whose messages can fail needs somewhere for them to land. Select a Queue and choose **Add
DLQ** (in the popover, the right-click menu or the palette). Draft Canvas adds a dead-letter queue
beside it, connected with a dashed *dead-letters to* connector. Click that connector to set how many
deliveries are attempted before a message is parked; the default is three.

A Topic never dead-letters: retries and a DLQ belong to each subscriber's own queue, which is what
the suggestion after a Topic offers.

## Branch through a junction

When one source reaches several targets along the same route, press `J` to drop a **Junction**, a
small point you connect through. Connectors into and out of a junction keep the relationship of the
shapes on either side; the junction itself adds no meaning. A bundle of connectors that already
share a route can become one: right-click it and choose **Convert to junction**.

## Boundaries

A boundary is a frame around shapes that share a scope. Select shapes and press `⌘G`, or press `B`
for an empty one and drag shapes in. Pick the boundary's kind (Boundary, Group, System, Domain,
Network, Deployment) in its bar; each has its own outline so it reads without the label. The
[getting started guide](getting-started.md#draw-a-boundary) walks through them.

## Where next

- [Explain a system at different levels](depth.md): keep the overview small and draw the detail
  inside a shape, C4-style.
- [Flows and presenting](flows-and-presentation.md): tell the story one step at a time.
- [Architecture semantics](../reference/semantics.md): every relationship the matrix offers, and why.
