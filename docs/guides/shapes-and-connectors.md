# Shapes, connectors and boundaries

Add a shape, choose its kind, then connect it. Draft Canvas suggests relationship labels
from the shapes at each end.

Shortcuts use Mac keys. On Windows and Linux, use `Ctrl` for `⌘`.

## Pick the right kind

Press a shape's key to add it. Select it to choose a kind in its toolbar.

| Shape | Key | Kinds |
| --- | --- | --- |
| Service | `S` | Service, API, Worker, External System, Scheduler, Gateway |
| Data Store | `D` | Database, SQL, NoSQL, Cache, File system, Object storage, Search index, Table |
| Queue | `Q` | Queue, Topic, Stream |
| Actor | `A` | Human, System, Device, Group, Third Party |
| Component | `M` | Component, Module, Adapter, Port |

Use **External System** for a service you do not own. Actors start borderless;
**Actor frame → Framed** adds an outlined card.

## Technology and description

Select a shape, then **⋯ → Edit details…**. Enter a **Technology** and **Description**.
Choose a technology suggestion with the arrow keys and `Enter`, or keep your own text.
Aliases such as `Postgres` and versioned names such as `Rust 1.90` work.

![Technology suggestions for PostgreSQL.](../media/guides/technology-suggestions.png)

A technology icon appears beside the shape. Click it for the full name and version.
Custom or mixed stacks use a generic icon. Clear the field to remove it.
Icons are bundled locally and included in image exports.

## Keep names readable

Double-click a shape, or select it and press `Enter`, to rename it.
`Enter` commits; `Esc` cancels. Shapes grow to fit new names.

For an older label that is shortened, select the shape and run **Fit shapes to text**
from `⌘K`. It expands the shape without moving it.

## Say what the arrow means

Drag from a shape's edge dot onto another shape. Drop on empty space to create and connect
a new shape instead. For a keyboard route, select a shape and run **Connect to…** from `⌘K`.

Click a connector to change its relationship. Labels read in the arrow's direction:
`Orders API → orders` says *sends command to*.
The [semantics reference](../reference/semantics.md#the-capability-matrix) lists the rules.

- Hold `Shift` and click to select several shapes or connectors.
- Drag a selected connector's endpoint to change its target or attachment side; `Esc` cancels.
- When connectors share one label, click it again to cycle through them.

## Bend a connector by hand

Select a connector, then:

| Style | Edit the route |
| --- | --- |
| **Stepped** | Drag a bar on a straight run sideways. Snap it level to remove a jog. |
| **Straight / Curved** | Drag a faint dot to add a bend; drag a square to move it; double-click a square to remove it. |

Each drag is one undo step. Right-click → **Reset route** restores automatic routing.
**Tidy connectors** in `⌘K` resets all routes.

## Sync, async and the reply

For a connector between services, open **Interaction** in its popover:

- Choose **HTTP** or **Generic Call**.
- **Sync** means the caller waits. **Async** means it carries on, shown by a break mark.
- Turn **Response** on for a reply and enter its label, or use **Guess**. Switching to Async removes the reply.

The context menu also offers **Make asynchronous** and **Make synchronous**.

## Put a note or payload on a connector

Right-click a connector to attach a Note or Code shape. Or drag an existing one onto the line
and hold until it docks. Click the chip to read it; drag it off to detach it.

## Mark the failure path

Select a Queue and choose **Add DLQ** from its popover, context menu or `⌘K`.
This adds a dead-letter queue and a *dead-letters to* connector.
Click the connector to set delivery attempts; the default is three.
For a Topic, put the DLQ on each subscriber's queue.

## Branch through a junction

Press `J` to add a Junction for a shared route. Connect through it as usual;
relationships still describe the shapes on either side.
Right-click an existing bundle and choose **Convert to junction** to convert it.

## Boundaries

Select shapes and press `⌘G`, or press `B` for an empty boundary and drag shapes in.
Moving, copying or deleting a boundary includes its contents.
Choose its kind and colour in the toolbar:

| Kind | Use it for |
| --- | --- |
| Boundary | A general frame |
| Group | Shapes that belong together for this explanation |
| System | One software system |
| Domain | A shared domain responsibility |
| Network | A network scope |
| Deployment | A runtime or hosting scope |

Kinds change the outline and header; they do not enforce architecture rules.

Next: [look inside a shape](depth.md) or [present a flow](flows-and-presentation.md).
