# Connect an AI agent

Let a coding agent, such as Claude Code, Codex, Cursor, Gemini CLI or Junie, draw and update diagrams
in Draft Canvas Desktop on macOS or Windows. Agents reach only the folders you allow. Your agent may
send diagram content to its AI provider, as it does with code.

## Turn it on

1. Open **Connect an agent…** on Home, or **Settings → AI agents**.
2. Turn on **Allow agent access**.
3. Under **Allowed folders**, tick the folders the agent may use. Subfolders are included. A folder
   is listed once you have opened it in Draft Canvas.
4. Under **Connect an agent**, choose your agent and click its button.
5. Optional: under **Agent skill**, click **Install skill**. It teaches the agent to draw a repository.
6. Start a new agent session. Keep Draft Canvas running while the agent works.

![AI agent settings with Add to Codex.](../media/guides/agent-setup-codex.png)

| Agent | Button |
| --- | --- |
| Claude Code | **Add to Claude Code** (every project) |
| Codex | **Add to Codex** |
| Cursor | **Add to Cursor** (opens Cursor) |
| Gemini CLI | **Add to Gemini CLI**; start sessions in a trusted folder |
| Junie | **Add to Junie** |
| Other MCP clients | Copy the `mcpServers` entry into the client's configuration |

If Draft Canvas cannot find `claude` or `gemini`, Settings shows a terminal command instead. To
configure by hand, open **Set it up by hand instead** (Cursor: **Copy the config instead**).

The skill installs in `~/.claude/skills` (Claude Code) or `~/.agents/skills` (other agents) and
updates with Draft Canvas. An edited copy is kept until you click **Replace skill**.

## Draw a repository

Open your agent in the repository and ask:

> Use the Draft Canvas skill to draw this repository's architecture. Show the main request
> path as a presentation flow, put service details inside their shapes, and cite source files.

Ask it to mark inferences and open questions. Draft Canvas shows source evidence but does not check it.

![A storefront diagram with services, stores, an event stream and workers.](../media/guides/agent-skill-example.png)

Follow-ups change the same diagram:

- "Add a billing dead-letter queue and explain the retry policy in a note."
- "Show the components inside Orders API."
- "Refresh this diagram from the changed code; keep my notes and arrangement."

To limit a change, select shapes first and say so: "Add a retry path around this selection." The
agent changes only what was selected when it read the selection.

Agents use ordinary shapes, connectors, notes, flows and [rich text](shapes-and-connectors.md#write-rich-text).

## Watch and undo

- Longer requests show progress above the status bar, with **Show** for a new diagram.
- **Cancel** works until the line says *Applying…*. After that, use Undo. Each change is one undo step.
- A change saves automatically if you had no unsaved edits. Otherwise you save it.

## Review a proposal

To check changes before they are applied, ask for a proposal:

> Compare this pull request with the diagram. Propose the architectural changes without applying them.

1. Click **1 proposal to review** above the diagram.
2. Read the changes. **Focus changes** shows them on the canvas.
3. Click **Accept** to apply the whole proposal, or **Reject** or **Dismiss**.

To accept only part, ask the agent to revise it. If something the proposal is about has changed,
**Accept** stays disabled until the agent revises it.

## While the window is hidden

- **macOS 14 or later:** agents keep working. Restart once if Settings asks.
- **macOS 12–13 and Windows:** keep the window open.

## Stop an agent

In **Settings → AI agents**:

- **Disconnect agents** › **Disconnect** ends connections. Set-up agents reconnect on their next request.
- Untick a folder to remove access. A ticked parent folder still includes it.
- Turn off **Allow agent access** to stop everything. Folder choices are kept.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Draft Canvas not running or not responding | Open it, check access is on, and keep the window open where required. |
| Folder not allowed | Tick it under **Allowed folders**. |
| Layout refused | Ask for a smaller diagram, or put detail inside services. |
| Version mismatch, or Settings shows **Update** *agent* | Click it to point the agent at this copy of Draft Canvas. |
| Claude Code finds Draft Canvas in one folder only | Use **Add to Claude Code**, which sets it up for every project. |

Tools, limits and error codes: [Agent integration](../reference/agent-integration.md).
