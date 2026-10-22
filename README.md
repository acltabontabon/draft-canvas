<div align="center">

<img src="www/public/favicon.svg" width="64" height="64" alt="">

# Draft Canvas

### Draw software. Explain how it works.

A local-first canvas for turning software architecture into a clear visual story.<br>
Sketch an idea. Explore the detail. Walk through the flow.

**[draftcanvas.dev](https://draftcanvas.dev/)** ·
**[Try it in your browser](https://app.draftcanvas.dev/)** ·
**[Download for macOS & Windows](https://github.com/acltabontabon/draft-canvas/releases/latest)** ·
[Documentation](https://draftcanvas.dev/docs/)

</div>

<img width="100%" alt="Draft Canvas in action: sketching an architecture, presenting a flow, exploring inside a service, and sharing the diagram." src="docs/media/demo.gif">

## Made for explaining software

- **Draw with meaning.** Sketch services, data stores and queues with connectors that describe how they relate.
- **Keep the overview clear.** Draw the detail inside a shape, from a system overview down to individual components.
- **Tell the story.** Present flows step by step. Attach notes and mark open questions.
- **Draw together, live.** Share one link and edit a canvas with others in real time. Your browser hosts the session: no account, and your diagram never passes through a server.
- **Keep ideas moving.** Draw from the keyboard, accept suggestions, or begin with a ready-made architecture starter.
- **Take your work with you.** Import Mermaid flowcharts. Export images, editable files and architecture source, or share read-only links.
- **Draw with your coding agent.** Connect an MCP-compatible agent to the desktop app to draw a whole repository or revise a diagram.

## Install

Use the [web editor](https://app.draftcanvas.dev/), or download the desktop app for
macOS or Windows from the [latest release](https://github.com/acltabontabon/draft-canvas/releases/latest).
On a Mac you can also install it with Homebrew:

```bash
brew install --cask acltabontabon/tap/draft-canvas
```

See the [desktop guide](docs/guides/desktop.md#installing) for first-launch steps, and
[Contributing](CONTRIBUTING.md) to build and run it from source.

## Try it on your own repo

Connect Claude Code, Codex, Cursor, Gemini CLI, Junie or another MCP agent:

1. Add your project folder in Draft Canvas Desktop.
2. In **Settings → AI agents**, turn on **Allow agent access** and tick the folder.
3. Pick your agent, click **Add to…**, then **Install skill**. Start a new agent session.
4. Ask:

> Use the Draft Canvas skill to draw this repository's architecture, with a flow for
> the main request path and source references for the important parts.

Ask it to refresh the same diagram when the code changes.
[Setup and troubleshooting →](docs/guides/connect-an-ai-agent.md)

## Built with

[React](https://github.com/react/react), [React Flow](https://github.com/xyflow/xyflow),
[Tauri](https://github.com/tauri-apps/tauri), [Simple Icons](https://github.com/simple-icons/simple-icons)
and other open-source projects. Full [credits](docs/reference/third-party.md) and
[licences](THIRD_PARTY_LICENSES.txt).

---

<div align="center">

Free and open source · [Apache 2.0](LICENSE) · [Feedback & ideas](https://github.com/acltabontabon/draft-canvas/issues/new/choose)

</div>
