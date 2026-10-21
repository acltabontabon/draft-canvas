# Connect an AI agent

Let a coding agent draw or update diagrams in Draft Canvas Desktop.
This needs the running desktop app on macOS or Windows and an MCP-compatible agent.

Draft Canvas limits access to the folders you allow. Your agent may send diagram content
to its AI provider, just as it does with code.

## Turn it on

1. Open **Connect an agent…** on Home, or **Settings → AI agents**.
2. Turn on **Allow agent access**.
3. Tick the project folders the agent may use. Add a project in Draft Canvas first if it is missing.
   A ticked folder includes its subfolders.
4. Under **Connect an agent**, choose your agent and click its **Add to…** button.
5. Under **Agent skill**, click **Install skill**, then start a new agent session.

![AI agent settings with Add to Codex.](../media/guides/agent-setup-codex.png)

The skill is optional, but provides the repository-drawing workflow.
Keep Draft Canvas running while the agent works.

### Client setup

| Agent | Setup |
| --- | --- |
| Claude Code | **Add to Claude Code** adds a user-scope MCP server. |
| Codex | **Add to Codex**, then start a new chat. |
| Cursor | **Add to Cursor** opens Cursor's setup. |
| Gemini CLI | **Add to Gemini CLI**, then start a session in a trusted folder. |
| Junie | **Add to Junie**, then start a new session. |
| Other clients | Copy the displayed `mcpServers` entry into the client's configuration. |

If `claude` or `gemini` is not found, run the terminal command shown in Settings.
For manual setup, use **Set it up by hand instead** or Cursor's **Copy the config instead**.
Cursor accepts `~/.cursor/mcp.json` or a project's `.cursor/mcp.json`.

Codex uses `~/.codex/config.toml`, or `CODEX_HOME` when set.
If Settings shows **Update**, use it to point the client at the current Draft Canvas installation.

## Draw a repository

Open your agent in the repository and ask:

> Use the Draft Canvas skill to draw this repository's architecture. Show the main request
> path as a presentation flow, put service details inside their shapes, and cite source files.

The agent surveys the code, chooses context/container/component views, adds flows and notes,
then checks the layout and rendered image. Ask it to mark inferences and open questions.
Draft Canvas displays source evidence but does not verify it against your repository.

![A storefront diagram with services, stores, an event stream and workers.](../media/guides/agent-skill-example.png)

Continue with plain requests:

- “Add a billing dead-letter queue and explain the retry policy in a note.”
- “Show the components inside Orders API.”
- “Move the cache below the database.”
- “Refresh this diagram from the changed code; preserve my notes and arrangement.”

Follow-ups update the same diagram. Changes use ordinary shapes, connectors, notes and flows.
Each committed update is one undo step. Agents can add [rich text](shapes-and-connectors.md#write-rich-text)
with tables, checklists, code or callouts, and set its font, colour and background.

### Where the skill lives

| Agent | Skill folder |
| --- | --- |
| Claude Code | `~/.claude/skills/draft-canvas` |
| Codex, Cursor, Gemini CLI, Junie and others | `~/.agents/skills/draft-canvas` |

The installed skill updates with Draft Canvas. Edited copies are left alone until you choose
**Replace skill**, which keeps a backup. **Remove skill** uninstalls it; newer copies are never downgraded.

## Work on a selection

Select shapes or a flow, then ask for a scoped change:

> Add a retry path around this selection. Preserve everything else.

The agent can read the selection and nearby context, inspect a temporary candidate,
and apply it once ready. Clicking elsewhere does not change the selection it already read.
For a crowded overview, ask it to move detail inside a service.

## Watching it work

Longer requests show progress above the status bar. **Show** opens a new-diagram preview;
existing-diagram changes appear faintly over the canvas.
Previews do not change the saved diagram.

**Cancel** stops work before it reaches *Applying…*. After that, use Undo.
If you edit while a change is being prepared, the agent must read the updated diagram before retrying.

## Reviewing a proposal

Ask for a proposal when you want to review before applying:

> Compare this pull request with the diagram. Propose the architectural changes without applying them.

1. Click **N proposal(s) to review** above the diagram.
2. Review the summary, additions, removals and before/after values.
   Use **Focus changes** to find them on the canvas.
3. Choose **Accept** to apply the whole proposal as one undo step, or **Reject** / **Dismiss** to leave the diagram unchanged.

For a smaller change, ask the agent to revise the proposal; partial acceptance is unavailable.
If a targeted element changed, Accept is disabled until revision.
After an interrupted accept, **Mark as applied** may appear when the change already landed.

## Saving

Agent changes save automatically only if the diagram had no unsaved edits of your own.
Otherwise the change stays in the editor for you to save; a recovery copy is kept.
Changes to another diagram do not replace the one you are viewing.

## While the window is hidden

- **macOS 14 or later:** agents can work with the window closed. Restart once after enabling access if Settings requests it.
- **macOS 12–13 and Windows:** keep the window open; hidden windows may pause.

## Stopping an agent

In **Settings → AI agents**:

- **Disconnect agents** ends connections; configured clients can reconnect on their next request.
- Untick a folder to revoke access to it immediately.
- Turn off **Allow agent access** to stop all access. Folder choices are kept.

## When something goes wrong

| Problem | Fix |
| --- | --- |
| App not running / responding | Open Draft Canvas, check access is on, and keep the window open where required. |
| Folder not allowed | Tick it under AI agents, or use an allowed folder. |
| Layout rejected | Ask for a smaller diagram or put detail inside services. |
| Connector version mismatch | Click **Update** in client setup, or copy its current configuration again. |
| Claude Code works in only one folder | Use **Add to Claude Code** for user-scope setup. |

Tool authors: see the [MCP reference](../reference/agent-integration.md) for schemas, limits,
retry behavior, proposals and verification coverage.
