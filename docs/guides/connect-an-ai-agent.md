# Connect an AI agent

Draft Canvas Desktop can let a coding agent on your computer — Claude Code, Cursor, or any other
agent that speaks MCP (the Model Context Protocol) — draw diagrams for you. Ask your agent to "draw
how orders flow through this service". It reads your code, then hands Draft Canvas a description:
the parts, how they connect, the flows. Draft Canvas lays it out and draws it as an ordinary diagram
you can edit, move, present and export like one you drew yourself.

The agent never places anything by coordinates, and never touches a file outside the folders you
allow. Draft Canvas doesn't send your diagrams anywhere. Your agent does send what it reads and
writes to its own AI provider, as it does with your code.

This needs the desktop app, on macOS or Windows. The web app and VS Code open the diagrams it makes,
but agents can't reach them.

## Turn it on

1. Open **Settings** (`⌘,` / `Ctrl+,`, or from the tray menu) and find **AI agents**.
2. Tick **Let coding agents on this computer draw diagrams**.
3. Tick each project folder an agent may use. A folder appears here once you have opened it in Draft
   Canvas. Agents can list, read, create and change diagrams only in the folders you tick.
4. Set up your agent from the same place:
   - **Claude Code**: run the copied command, for example
     `claude mcp add draft-canvas -- "/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp"`.
   - **Cursor**: click **Add to Cursor** — it opens Cursor and adds Draft Canvas to its MCP
     configuration for you. If nothing opens (no `cursor://` links registered, or you'd rather add it
     to a project's own configuration first), use **Or copy the config instead** and paste it into
     `~/.cursor/mcp.json`, or a project's `.cursor/mcp.json`.
   - **Other agents**: add the copied `mcpServers` entry to the agent's MCP configuration.

Draft Canvas must be running while the agent works: the connector talks to the running app. It
doesn't start the app for you, and it says so if the app isn't open.

## What the agent can do

- **Create a diagram**. It is written as a new file in an allowed folder, laid out automatically, and
  checked for readability before it's saved. It never replaces an existing file, and an agent that
  tries to create a second diagram with a title you already have is told to change that one instead.
  It opens by itself if nothing else is open, or when you asked to see it and have nothing unsaved.
- **Keep working on the same diagram.** Follow-ups — "add a dead-letter queue", "rename that
  service", "explain the retry in a note", "add a flow for the normal path" — change the diagram the
  agent made, not a new one, whether or not it is open. The rules:
  - What you arranged by hand stays where you put it. New parts are placed beside what they connect to.
  - Each change is **one undo step** (`⌘Z` / `Ctrl+Z`). A change to a diagram that isn't open is
    saved to its file without switching what you're looking at; a notice offers **Show**, and opening
    it then has the change as its undo step.
  - "Clean up the arrows and spacing" re-arranges the diagram in place — the same shapes, notes and
    flows, laid out again. You can ask for just one boundary, or just a tidier connector or two
    without moving anything.
  - Shapes that play the same role — a row of actors, a row of external systems — come out one
    consistent size automatically, without an unusually long description enlarging the rest of them.
  - If two diagrams have the name you mention, the agent asks you which.
- **Add notes and flows.** A note can sit beside a shape, inside a boundary, or be attached to a shape
  or connector so it moves with it. Flows walk through the connectors that are already there, and
  play in presentation mode.
- **Read a diagram**, including what is inside a shape, a boundary or a flow on its own.
- **Edit only what you selected.** Select a service and the thing downstream of it, then ask for "a
  retry path around this selection, preserve everything else" — the agent reads exactly those ids and
  a few neighbours for orientation, and edits only them, even if you click something else on screen
  while it's working.
- **Propose a change for you to review**, instead of applying it directly — the way it handles "review
  this pull request against the diagram, show me the architectural impact, don't apply it yet." See
  [Reviewing a proposal](#reviewing-a-proposal) below.
- **Use a diagram as context for implementing something**, reading a flow's steps in the order they
  actually happen, the notes and decisions around them, and the boundaries involved — for a request
  like "use the selected flow as the design for implementing this in the repository."
- **Walk through what happens if a step fails**, as a separately named flow built from the shapes
  already there — "using the payment flow, show what happens if the charge times out after the order
  was placed" — switchable against the normal flow without leaving presentation (`Shift+F`).
- **Use C4.** Describe systems at context, container and component level, with a technology and a
  one-line description on each element; they appear under its name. You can edit both in the
  element's **Details**.
- **Start from an Architecture Starter**, renamed and extended.

## An example

> **You:** Draw this architecture: a web storefront calls the Orders API, which writes to Postgres
> and publishes OrderPlaced to a topic feeding a billing queue and a notifications queue.
>
> *The agent creates one diagram and keeps its id.*
>
> **You:** Add a dead-letter queue for billing and explain the retry behaviour in a note.
>
> *Same diagram: the queue is placed beside billing, the note beside the queue.*
>
> **You:** Add a flow for the normal processing path.
>
> *Same diagram: a flow over the connectors already there.*
>
> **You:** Clean up the arrows and spacing.
>
> *Same diagram, re-arranged in place: the main path straight, the dead-letter path off to the side.*

## Watching it work

A request that takes more than a moment shows a line above the status bar — "AI agent Drawing
*Checkout* — Routing connections…" — with **Cancel**. Quick ones just appear finished.

- A **new diagram** can be watched as it is arranged, in a view marked *Not saved yet*. It appears by
  itself when nothing else is open; otherwise click **Show**. Drag and scroll to look around;
  **Follow** keeps the whole diagram in view as it changes, **Hide** puts it away.
- A **change to the diagram you have open** is drawn faintly on top of it, tagged *Agent's proposed
  change*, until it is applied. You can keep working; if you edit something meanwhile, your edit wins
  and the agent is told to look again.
- **Cancel** stops a change before it is applied, and nothing changes. Once the line says
  *Applying…*, it's too late to cancel — use Undo.

Nothing you see while an agent works is saved or undoable until it is actually applied.

## Reviewing a proposal

When you ask an agent to review a change against a diagram rather than apply it directly, it submits
a **proposal** instead — Draft Canvas never fetches or reads the pull request itself, only the
structured description of the change the agent sends. A small **N proposal(s) to review** button
appears over the diagram; click it to open the review panel.

The panel shows the agent's summary and reasoning, its assumptions and open questions, and every
addition, modification and removal apart from each other — for a modification, the actual before and
after values, not just a highlighted shape. **Accept** applies the whole thing as one ordinary undo
step (`⌘Z` / `Ctrl+Z` reverts it exactly like any other edit); **Reject** and **Dismiss** leave the
diagram untouched. There is no partial accept — if you want a smaller change, ask the agent to revise
the proposal, which updates the same one in place rather than creating a second.

If the diagram changed elsewhere since the proposal was written, a note says so but doesn't block
Accept; if something the proposal is specifically *about* changed — a renamed element, a moved
connector — Accept is disabled until the agent revises it. A proposal survives a restart: if Draft
Canvas quit mid-accept, it's recovered automatically the next time you look at it.

## Saving

An agent's change is saved for you only when the document had no unsaved changes of your own. If you
were in the middle of something, the change is applied in the editor and left for you to save with
yours; the recovery copy keeps it safe meanwhile. The agent is told which of the two happened.

If you edit while an agent is preparing a change, your edit wins: the agent is told the diagram
changed, and has to read it again before retrying.

## While the window is hidden

On macOS 14 and later, agents can keep working while Draft Canvas sits in the menu bar with its
window closed. If you turn access on while the app is running, **restart it once** for that to take
effect; Settings says so.

On macOS 12 and 13, and on Windows, keep the Draft Canvas window open while an agent works. A hidden
window may be paused by the system, and the agent is then told the app isn't responding. Nothing is
changed in that case.

## Stopping an agent

- **Disconnect agents** in Settings ends every open connection and replaces the connection secret.
  Agents you have set up reconnect on their next request.
- Untick a folder to put it out of reach at once, including any retry of an earlier request.
- Untick **Let coding agents on this computer draw diagrams** to turn access off completely. Nothing
  can connect until you turn it on again.

## When something goes wrong

- **The agent says Draft Canvas isn't running.** Open Draft Canvas, and check that access is on.
- **"Not in a folder agents may use."** Tick the folder under **AI agents**, or ask the agent to use
  one you allowed.
- **The agent says the layout wasn't readable.** Very large diagrams at once (about 50 or more
  elements) are hard to lay out cleanly. Ask for the diagram in steps, or as an overview with the
  detail drawn inside its shapes.
- **The agent's connector is a different version.** Point the agent at the connector inside the Draft
  Canvas you are running: copy the setup from Settings again after updating the app.

For how it works — the protocol, the guarantees about retries, what is and isn't supported — see
[Agent integration](../reference/agent-integration.md).

## What was actually tested

Claude Code on macOS is exercised end-to-end (the existing agent test suite, including this round's
proposal review flow). Cursor's setup is verified for correctness — the deeplink's config payload and
the pasted-config fallback are unit-tested to decode to the exact same server definition, and the
`cursor://` URL and `~/.cursor/mcp.json` shape match Cursor's own published format — but connecting a
real Cursor install to Draft Canvas has not been run in this environment; treat it as
configuration-verified, not as a tested connection, until it's been tried against an actual Cursor.
Windows and Linux are untested for every client in this round, same as before it.
