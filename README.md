<div align="center">

<img src="www/public/favicon.svg" width="64" height="64" alt="">

# Draft Canvas

### Draw software. Explain how it works.

Turn a repository into a diagram. Walk your team through a request. Work out what to build next.

Draft Canvas brings architecture, live collaboration and your own coding agent onto one canvas.

**Your architecture, your agents, your decisions.** ([Principles](docs/reference/principles.md))

**[draftcanvas.dev](https://draftcanvas.dev/)** ·
**[Try it in your browser](https://app.draftcanvas.dev/)** ·
**[Download for macOS & Windows](https://github.com/acltabontabon/draft-canvas/releases/latest)** ·
[Documentation](https://draftcanvas.dev/docs/)

</div>

<img width="100%" alt="Draft Canvas in action: sketch an architecture, present a request flow, explore inside a service, and share the diagram." src="docs/media/demo.gif">

## Make the system make sense

A useful architecture diagram answers questions: what talks to what, where the data goes, and what
happens when something fails. Draw those answers, then walk someone through them.

- **Start with the big picture. Go inside when it matters.** Put services, stores and queues on the
  canvas, then look inside a shape for its components. Keep the overview readable without losing detail.
- **Play the request, step by step.** Turn a path through the system into a presentation flow.
  Show the happy path, switch to a failure path, and explain the decisions along the way.
- **Keep the reasoning beside the design.** Attach rich-text notes, cite source files and mark
  open questions on the parts they concern.
- **Get an idea down while it's fresh.** Draw from the keyboard, accept connection suggestions,
  or start with an architecture pattern and make it your own.

## Meet Nodi. Bring your own agent.

“Walk me through this.” “What breaks first?” “Add a retry path.”

Nodi lives in the corner of Draft Canvas Desktop and runs your own **Claude Code or Codex**.
Ask about the diagram you're looking at: answers point to the parts they discuss, and proposed
changes appear on the canvas for you to compare and accept. Keep thinking in the diagram.

Already working in your coding agent? Connect **Claude Code, Codex, Cursor, Gemini CLI, Junie or any
MCP client** to turn a real repository into editable architecture, then refresh it as the code changes.

[Connect your agent →](docs/guides/connect-an-ai-agent.md)

## Get everyone on the same canvas

Share a live session and draw together on web or desktop. Approve who joins, choose who can edit,
and take back control when you need it. Your copy hosts the session and saves the diagram.

For an async handoff, share a read-only link or a passphrase-protected one. Export an image for a
design review, an editable file for a teammate, or Mermaid, PlantUML, Structurizr and draw.io source
for the tools you already use. You can import Mermaid flowcharts, too.

## Your architecture stays yours

Local-first. No account required. No diagram server. Work offline, keep your files, and choose
which folders your agent can access. When you use an AI agent, it connects through your own agent
setup and provider.

Free and open source under Apache 2.0. [Privacy and security →](SECURITY.md)

[What's new in 1.16](https://github.com/acltabontabon/draft-canvas/releases/tag/v1.16.0) ·
[All guides](docs/index.md)

## Get started

- **Web:** open [app.draftcanvas.dev](https://app.draftcanvas.dev/). Nothing to install.
- **macOS and Windows:** download from the [latest release](https://github.com/acltabontabon/draft-canvas/releases/latest),
  or on a Mac:

  ```bash
  brew install --cask acltabontabon/tap/draft-canvas
  ```

First launch: [desktop guide](docs/guides/desktop.md#installing). Build from source: [Contributing](CONTRIBUTING.md).

## Put your repository on the canvas

Give your next code review, onboarding session or design discussion a map of the actual code.

1. Open your project folder in Draft Canvas Desktop.
2. In **Settings → AI agents**, turn on **Allow agent access** and tick the folder.
3. Click **Add to…** for your agent, then **Install skill**. Start a new agent session.
4. Ask:

   > Use the Draft Canvas skill to diagram this repository's architecture as C4 views, down to
   > components where the code has real logic. Read the code before you draw, cite source files
   > and mark anything inferred. Make the main request path a presentation flow, with variants for
   > the failure paths the code handles, and leave open questions as notes. Render every view and
   > fix what reads badly before you finish.

Ask again to refresh the same diagram when the code changes.
[Setup and troubleshooting](docs/guides/connect-an-ai-agent.md)

## Contribute

[Build and contribute](CONTRIBUTING.md) · [Architecture](docs/reference/architecture.md) ·
[Credits](docs/reference/third-party.md) · [Licences](THIRD_PARTY_LICENSES.txt)

---

<div align="center">

Free and open source · [Apache 2.0](LICENSE) · [Feedback & ideas](https://github.com/acltabontabon/draft-canvas/issues/new/choose)

</div>
