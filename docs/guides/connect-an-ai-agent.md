# Connect an AI agent

Let a coding agent such as Claude Code, Codex, Cursor, Gemini CLI, Junie or OpenCode draw and update
diagrams in Draft Canvas Desktop, on macOS or Windows.

Agents reach only the folders you allow. Your agent may send diagram content to its AI provider, as
it does with code. [Agent integration](../reference/agent-integration.md) describes the tools agents
use.

## Turn it on

1. Open **Connect an agent…** on Home, or **Settings → AI agents**.
2. Turn on **Allow agent access**.
3. Under **Allowed folders**, tick the folders the agent may use. Subfolders are included. A folder
   is listed once you have opened it in Draft Canvas.
4. Under **Connect an agent**, choose your agent. An agent that is already set up has a tick.
5. **Connect** *agent*: click the agent's button (see the table).
6. **Add the skill** (optional): click **Install skill**. It teaches the agent to draw a repository.
7. **Try it**: start a new agent session and ask it to list your Draft Canvas diagrams. The step
   says **1 agent connected** once the agent gets through.

![AI agent settings with Add to Codex.](../media/guides/agent-setup-codex.png)

| Agent | Button |
| --- | --- |
| Claude Code | **Add to Claude Code** (every project) |
| Codex | **Add to Codex** |
| Cursor | **Add to Cursor** (opens Cursor) |
| Gemini CLI | **Add to Gemini CLI**; start sessions in a trusted folder |
| Junie | **Add to Junie** |
| OpenCode | **Add to OpenCode** (every project), then restart OpenCode; see [OpenCode](#opencode) |
| Other MCP clients | Choose **Other** and copy the `mcpServers` entry into the client's configuration |

If Draft Canvas cannot find `claude` or `gemini`, Settings shows a terminal command to run instead.
To configure by hand, open **Set it up by hand instead** (Cursor: **Copy the config instead**).

Keep Draft Canvas running while the agent works. On macOS 14 or later, agents keep working while the
window is hidden (restart once if Settings asks). On macOS 12–13 and Windows, keep the window open.

The skill installs in `~/.claude/skills` (Claude Code) or `~/.agents/skills` (other agents) and
updates with Draft Canvas. A copy you have edited is left alone until you click **Replace skill**,
which backs it up first.

### OpenCode

**Add to OpenCode** adds a `draft-canvas` server to `~/.config/opencode/opencode.json` (on Windows,
`.config\opencode\opencode.json` in your user folder) and keeps the rest of the file. **Set up**
means the file is written; **Try it** says when OpenCode has connected. To check from OpenCode's
side, run this in your project folder. It should list `draft-canvas` as connected.

```bash
opencode mcp list
```

Draft Canvas leaves the file alone, and says why, when:

- It has comments or trailing commas, which Draft Canvas cannot keep. If only `opencode.jsonc` has
  them, `opencode.json` beside it is written instead; OpenCode reads both.
- Draft Canvas is set up more than once: in both files, or under both `mcp` and `mcp.servers`. Keep
  one, then click again.
- A server named `draft-canvas` is something else, such as a remote server. Rename or remove it.

To set it up by hand, or for one project only, paste the entry from **Set it up by hand instead**
into that file or the project's `opencode.json`. Access is still limited to **Allowed folders**.

## Draw a repository

Open your agent in the repository and ask:

> Use the Draft Canvas skill to map this repository’s runtime architecture. Verify boundaries
> and connections in source, cite evidence, and mark inferences. Add component views where
> they explain real logic, and presentation flows for verified requests and handled failures.
> Don’t turn dependencies or concurrent effects into an invented execution order. Inspect every
> view and fix readability before finishing; tell me the scope and any unresolved questions.

Draft Canvas shows the agent's source evidence but does not check it, so read the inferred parts and
open questions first.

![A storefront diagram with services, stores, an event stream and workers.](../media/guides/agent-skill-example.png)

Follow-ups change the same diagram:

- "Add a billing dead-letter queue and explain the retry policy in a note."
- "Refresh this diagram from the changed code; keep my notes and arrangement."
- "What happens if Payments goes down?" The agent reads the same [outage](outage.md#with-your-agent)
  the canvas shows.
- "What changed in this diagram since Monday?" The agent reads the diagram's
  [history](history.md#agents-and-history), but never restores or merges.

To limit a change, select shapes first and say so: "Add a retry path around this selection." The
agent changes only what was selected when it read the selection.

## Watch and undo

- Longer requests show progress above the status bar, with **Show** for a new diagram.
- **Cancel** works until the line says *Applying…*. After that, use Undo; each change is one undo
  step.
- A change saves automatically if you had no unsaved edits. Otherwise you save it.

## Review a proposal

To check changes before they are applied, ask for a proposal:

> Compare this pull request with the diagram. Propose the architectural changes without applying them.

1. Click **1 proposal to review** above the diagram.
2. Read the changes. **Focus changes** shows them on the canvas.
3. Click **Accept** to apply the whole proposal, or **Reject** or **Dismiss**.

To accept only part, ask the agent to revise it. If something the proposal is about has changed,
**Accept** stays disabled until the agent revises it.

## Ask Nodi, on the canvas

Nodi is the desktop app's companion: it asks your own Claude Code or Codex about the diagram you are
looking at. It appears at the end of the status bar once one of them is installed.

Nodi needs agent access on and the diagram saved in an allowed folder. Until then it says what is
missing and offers the fix: **Let Nodi in** turns agent access on, **Add project…** picks the
folder, and **Allow** *folder* lets agents use it.

![Nodi offering replies about the diagram.](../media/guides/nodi-open.png)

1. Click Nodi or press `⌘J` (`Ctrl+J`). Select shapes first to ask about them; `×` in the message
   box asks about the whole view instead.
2. Pick a suggestion (**Walk me through it**, **What breaks first?**) or type a question.
3. While the agent works, one line says what it is doing. **Stop** cuts the run off from the diagram
   tools at once.

Nodi answers some things itself, at no token cost: what is in the view, where the file is saved,
which folders agents can use, and the app's own commands, offered as buttons. Ask "what can you
do?" for the list.

![Nodi answering "What can you do?" itself, with buttons.](../media/guides/nodi-help.png)

![Nodi thinking: one live line, a feed on its screen.](../media/guides/nodi-thinking.png)

Answers point at the diagram. Hover a shape or connector's name to light it on the canvas. Each
point gets a numbered pin on the part it concerns; click a pin to read it. When an answer names a
shape that holds its own diagram, Nodi offers **Take me inside…**.

![A risk review pinned onto the diagram.](../media/guides/nodi-points.png)

- The pencil starts a new conversation. `>_` copies a command that reopens the latest turn in your
  agent's own terminal (a PowerShell command on Windows).
- With both agents installed, the name under the message box switches between them. Each diagram
  keeps one conversation per agent.
- The line under the message box shows the conversation's new tokens, and with an API key its cost.
  Plan limits and pricing are the provider's.

### Skills

Type `/` in Nodi's box, or click the **/** button, to list Nodi's skills:

- **Arrange:** `/across` (**Left to right**), `/down` (**Top down**), `/follow-…` (**Along** one of
  the first three flows), `/roomy` (**Give it room**), `/snug` (**Snug**) and `/tidy`
  (**Straighten connectors**). Nodi does these itself, with no agent and no tokens, each as one undo
  step. A shared, read-only diagram has none of them.
- **Ask:** `/explain` and `/risks` send the question to your agent.
- **Show:** `/present` plays the first flow that has steps.

### Changes come back as proposals

A question gets an answer and changes nothing. Nodi can offer to make a change, or to record the
risks it found as [open points](shapes-and-connectors.md#open-points).

A change comes back as a proposal on the canvas, with what changes in teal; a change that moves
shapes is shown on a tracing sheet over the diagram. **Now** / **Proposed** compares, and **Accept**
applies it as one undo step. Ask Nodi to adjust it ("keep the cache, but use Redis") and it revises
the same proposal.

![A proposal on the canvas, beside the change.](../media/guides/nodi-proposal.png)

![A tidy-up on the tracing sheet: each moved shape trails back to where it stands.](../media/guides/nodi-tracing.png)

**Review changes first** under the message box can switch to **Apply changes directly**: changes
then land at once, and Undo takes them back. Either way, an edit is refused if the diagram changed
while the agent was thinking, and an ambiguous name ("Orders" when two shapes have it) is sent back
for clarification.

To insert a starter, name it ("start CDC"); starters are available once you have loaded the
[starters gallery](getting-started.md#start-from-a-starter).

When your agent could do more outside Nodi's box, Nodi offers the same one-click setup as
**Settings → AI agents**:

- **Connect** *agent* **everywhere** adds Draft Canvas to the agent's MCP servers, so a
  conversation continued in its terminal still reaches the diagram.
- **Teach** *agent* **to draw** installs the skill.

To hide Nodi, turn off **Show Nodi on the canvas** in **Settings → AI agents**.

### What Nodi can reach

- **What runs:** your own CLI, signed in as you, in the background. It gets the Draft Canvas tools
  for this one diagram and nothing else: no shell, no file access, no other MCP servers, no hooks.
  For Codex, Nodi ignores `config.toml` to keep other tools out; it keeps your sign-in but uses
  Codex's default model and provider.
- **Reading your code:** when a question needs the code, Nodi asks first: **Just for now**,
  **Always for this folder** or **No**. **Another folder…** picks a different project. The folder is
  read-only for the agent, without `.git`, dependency and build folders, or secrets such as `.env`
  and keys. Folders allowed always are listed under **Settings → AI agents → Code Nodi may read**,
  where **Stop** takes one back.
- **Where conversations are kept:** in the agent's own sessions (`~/.claude/projects`,
  `~/.codex/sessions`). So that follow-ups can refer back, Draft Canvas also keeps up to 128 turns or
  64 KiB of requests and outcomes per diagram and agent in its private settings. They expire after
  30 days unused and are never stored in a diagram.

## Stop an agent

In **Settings → AI agents**:

- **Disconnect agents** → **Disconnect** ends connections. Set-up agents reconnect on their next
  request.
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
| OpenCode is **Set up**, but `opencode mcp list` doesn't show `draft-canvas` as connected | Restart OpenCode. If that doesn't help, something overrides the global file: a `draft-canvas` entry in the project's `opencode.json` or `.opencode/` folder, or `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT` or `XDG_CONFIG_HOME` set in your shell. `opencode debug config` shows what OpenCode loaded; paste the entry where it reads it. |
| **Add to OpenCode** says the file has comments, or that Draft Canvas is set up more than once | See [OpenCode](#opencode). |
| No Nodi in the status bar | Install Claude Code (2.1.295 or later) or Codex (0.163.0 or later), then reopen the diagram. |
| Nodi says the agent isn't signed in | Run `claude` or `codex` once in Terminal to sign in, then try again. A desktop app doesn't see an `ANTHROPIC_API_KEY` set only in a shell profile; sign in with the CLI instead. |
