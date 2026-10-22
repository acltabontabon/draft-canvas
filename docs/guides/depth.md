# Explain a system at different levels

Keep the overview small. Draw detail in a **room** inside a Service or Component,
then use **Look inside** to explore it.

Shortcuts use Mac keys. On Windows and Linux, use `Ctrl` for `⌘`.

## Draw the overview

Start with the people, system and external services your audience needs to see.

![Shop overview: Customer, Shop and Payment provider.](../media/guides/depth-overview.png)

## Look inside a shape

1. Select a Service or Component and press `⌘↓`, or choose **Look inside** from its context menu.
2. Draw its detail on the empty canvas: services, stores, queues or components.
3. Press `⌘↑` to return. `Esc` also goes out when nothing is selected.

You can repeat this inside another shape, up to three rooms below the top canvas.
A Port cannot have a room. Empty rooms disappear when their last shape is deleted.

## Tell the canvas what level it's showing

Run **View level…** from `⌘K`:

| Level | Shows |
| --- | --- |
| **System context** | People, this system and external systems |
| **Containers** | Apps, services and data stores |
| **Components** | Parts inside a container |
| **Nothing in particular** | A drawing with no level-specific suggestions |

Set the top level first. Rooms inside a System context view default to Containers;
rooms inside Containers default to Components. A room's own setting overrides that default.
Draft Canvas may offer to set System context when you first look inside an overview.

Levels guide suggestions; they never prevent a shape or connection.

## Find your way around

Open **Depth** in the canvas's top-left corner. Click a plane to go up, enter another room,
or explore below. Hovering a plane highlights its owner.

![The Depth control showing the overview above the current Shop room.](../media/guides/depth-map.png)

The control appears when a room exists, and always while inside one.
Click the level chip in the status bar to change **View level…**.

## Present and export at a level

- `⌘↓` and `⌘↑` also work during presentation.
- Inside a room, **Image** and **Source** exports let you choose the current room or whole canvas.
- A `.draftcanvas` file always includes every room. Copying or deleting a shape includes its room.

Everything stays in one file. Document limits count across all rooms;
see the [schema reference](../reference/schema.md).
