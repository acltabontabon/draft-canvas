<div align="center">

<img src="www/public/favicon.svg" width="64" height="64" alt="">

# Draft Canvas

### Draw software. Explain how it works.

An architecture canvas for developers. Map your code, walk through a request,
and work out what to build next—with your team and your own coding agent.

**[Try it in your browser](https://app.draftcanvas.dev/)** ·
**[Download for macOS & Windows](https://github.com/acltabontabon/draft-canvas/releases/latest)**

[Website](https://draftcanvas.dev/) · [Documentation](https://draftcanvas.dev/docs/)

Free and open source · No account required · Works offline

</div>

<img width="100%" alt="Draft Canvas in action: sketch an architecture, present a request flow, explore inside a service, and share the diagram." src="docs/media/demo.gif">

## Make the system make sense

A useful diagram shows what talks to what, where the data goes, and what happens when something
fails. Draft Canvas gives you room to explore those answers and explain them.

- **Explore the layers.** Map services, stores and queues, then look inside any shape for its
  components. Keep the big picture readable as the details grow.
- **Tell the story.** Play a request step by step, switch between happy and failure paths,
  and present the decisions along the way.
- **Keep the context.** Add rich-text notes, source references and open questions beside the
  parts they concern.
- **Stay in the flow.** Draw from the keyboard, follow connection suggestions, or start with an
  architecture pattern and make it your own.

## Meet Nodi. Bring your own agent.

“Walk me through this.” “What breaks first?” “Add a retry path.”

Nodi is your companion in Draft Canvas Desktop, powered by your own **Claude Code or Codex**.
Ask about the diagram in front of you. Answers point to the parts they discuss; proposed changes
appear on the canvas for you to review and accept.

Already working in your coding agent? Connect **Claude Code, Codex, Cursor, Gemini CLI, Junie or any
MCP client**. Turn a repository into editable architecture and refresh it as the code changes.

[Connect your agent](docs/guides/connect-an-ai-agent.md) · [Try the repository prompt](#put-your-repository-on-the-canvas)

## Get everyone on the same canvas

Draw together in a live session on web or desktop. Approve who joins and choose who can edit.
Your copy hosts the session and saves the diagram.

Share a read-only or passphrase-protected link for an async handoff. Export images, editable files,
or **Mermaid, PlantUML, Structurizr and draw.io** source. Import Mermaid flowcharts to keep working
with diagrams you already have.

## Your architecture stays yours

**Your architecture, your agents, your decisions.** Diagrams stay on your device. Work offline,
keep your files, and choose which folders your agent can access. AI runs through your own agent
setup and provider. You decide which proposed changes land.

[Our principles](docs/reference/principles.md) · [Privacy and security](SECURITY.md)

## Get started

**In your browser:** open [app.draftcanvas.dev](https://app.draftcanvas.dev/). Nothing to install.

**On macOS or Windows:** [download the desktop app](https://github.com/acltabontabon/draft-canvas/releases/latest)
for Nodi and repository access. On macOS, you can also use Homebrew:

```bash
brew install --cask acltabontabon/tap/draft-canvas
```

[Desktop setup](docs/guides/desktop.md#installing) · [Build from source](CONTRIBUTING.md)

## Put your repository on the canvas

Give your next code review, onboarding session or design discussion a map of the actual code.
With Draft Canvas Desktop:

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
[Agent setup and troubleshooting](docs/guides/connect-an-ai-agent.md)

## Explore and contribute

[All guides](docs/index.md) · [Changelog](CHANGELOG.md) ·
[Contributing](CONTRIBUTING.md) · [Architecture](docs/reference/architecture.md) ·
[Credits](docs/reference/third-party.md) · [Licences](THIRD_PARTY_LICENSES.txt)

---

<div align="center">

Free and open source · [Apache 2.0](LICENSE) · [Feedback & ideas](https://github.com/acltabontabon/draft-canvas/issues/new/choose)

</div>
