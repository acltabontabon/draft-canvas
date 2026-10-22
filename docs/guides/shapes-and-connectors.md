# Shapes, connectors and boundaries

Shortcuts use Mac keys. On Windows and Linux, use `Ctrl` for `⌘` and `Alt` for `⌥`.

## Shapes and kinds

Press a key to add a shape. Select it to choose a kind in its toolbar.

| Shape | Key | Kinds |
| --- | --- | --- |
| Service | `S` | Generic, API, Worker, External, Scheduler, Gateway |
| Data Store | `D` | Generic, SQL, NoSQL, Cache, File System, Object Storage, Search Index, Table |
| Queue | `Q` | Queue, Topic, Stream |
| Actor | `A` | Human, System, Device, Group, Third Party, AI Agent |
| Component | `M` | Generic, Module, Adapter, Port |
| Junction | `J` | |
| Boundary | `B` | See [Boundaries](#boundaries) |
| Text / Note / Code | `T` / `N` / `C` | |

Use **External** for a service you do not own. **Actor frame → Framed** outlines an actor.

## Names and technology

- Rename: double-click, or select and press `Enter`.
- A label cut short? Run **Fit shapes to text** from `⌘K`.
- Technology: **⋯ → Edit details…** → **Technology**. `Postgres` or `Rust 1.90` work; the shape
  shows a matching icon.

![Technology suggestions for PostgreSQL.](../media/guides/technology-suggestions.png)

## Connect shapes

- Drag from a shape's edge dot onto another shape, or onto empty space to create one.
- Keyboard: select a shape and run **Connect to…** from `⌘K`.
- Click a connector to change its relationship
  ([rules](../reference/semantics.md#the-capability-matrix)). Drag its end to reconnect it.

## Bend a connector by hand

Select a connector, then:

| Style | Edit the route |
| --- | --- |
| **Stepped** | Drag a bar on a straight run sideways. |
| **Straight / Curved** | Drag a faint dot to add a bend, drag a square to move it, double-click a square to remove it. |

Right-click → **Reset route** restores automatic routing. **Tidy connectors** (`⌘K`) resets all.

## Sync, async and the reply

Between two services, the connector's **Interaction** section sets **HTTP** or **Generic Call**,
and **Sync** (caller waits) or **Async** (shown with a break mark). Under **Response**, add a reply
line and its label, or click **Guess**. Async has no reply.

## More connector tools

- **Attach note** / **Attach code** (right-click), or drag a note onto the line and hold.
- **Add DLQ** on a Queue adds a dead-letter queue; click its connector to set delivery attempts.
- A Junction (`J`) shares a route. Right-click a bundle → **Convert to junction**.

## Boundaries

Select shapes and press `⌘G`, or press `B` and drag shapes in. Contents move, copy and delete
with the boundary. Pick a kind and colour in its toolbar:

| Kind | For |
| --- | --- |
| Boundary | A general frame |
| Group | Shapes that belong together for this explanation |
| System | One software system |
| Domain | A shared domain responsibility |
| Network | A network scope |
| Deployment | A runtime or hosting scope |

Kinds change the look only.

## Write rich text

Press `T`, then `Enter` to edit Markdown. **Aa** sets font, alignment and background
(**Card**, **Marker**, **Banner**).

| Write | Get |
| --- | --- |
| `#`, `##`, `###` | Headings |
| `**bold**`, `_italic_`, `~~struck~~`, `==highlight==` | Emphasis |
| `` `code` ``, fenced block with a language | Code |
| `- item`, `1. step`, `- [ ] todo` | Lists |
| `> quote`, `> [!WARNING]` | Quote, callout (NOTE, TIP, IMPORTANT, WARNING, CAUTION) |
| `\| A \| B \|` + `\| --- \| --- \|` | Table |
| `---` | Divider |
| `[words](https://…)`, `[words]{.rose}` | Link, coloured words |

![A Text shape's Markdown editor and format bar.](../media/guides/rich-text-editing.png)

| Keys while editing | Does |
| --- | --- |
| `⌘B` `⌘I` `⌘E` `⌘⇧X` `⌘⇧H` `⌘K` | Bold, italic, code, strikethrough, highlight, link |
| `⌘⇧8` `⌘⇧7` `⌘⇧9` | Bulleted, numbered, checklist |
| `⌘⌥1`–`⌘⌥3` | Heading 1–3 |

[Preview formatting examples.](../media/guides/rich-text.png)
