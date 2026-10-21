<div align="center">

<img src="www/public/favicon.svg" width="64" height="64" alt="">

# Draft Canvas

### Draw software. Explain how it works.

A local-first canvas for turning software architecture into a clear visual story.<br>
Sketch an idea. Explore the detail. Walk through the flow.

**[Try it in your browser](https://app.draftcanvas.dev/)** ·
**[Download for macOS & Windows](https://github.com/acltabontabon/draft-canvas/releases/latest)** ·
[Documentation](docs/index.md)

</div>

<img width="100%" alt="Draft Canvas in action: sketching an architecture, presenting a flow, exploring inside a service, and sharing the diagram." src="docs/media/demo.gif">

## Made for explaining software

- **Draw with meaning.** Sketch services, data stores and queues with connectors that describe how they relate.
- **Keep the overview clear.** Draw the detail inside a shape, from a system overview down to individual components.
- **Tell the story.** Present flows step by step. Attach notes and mark open questions.
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

Point Claude Code, Codex, Cursor, Gemini CLI or Junie at Draft Canvas Desktop and get your architecture drawn in minutes.

1. Open your project in the desktop app. In **Settings → AI agents**, turn on **Allow agent access**
   and pick your agent.
2. Click **Agent skill → Install skill**.
3. Ask your agent:

```text
Use the Draft Canvas skill to draw the architecture of this repository.
Use appropriate C4 views, meaningful grouping boundaries, and look-inside
details for key services. Attach decision notes, open questions and relevant
code snippets to the shapes, connectors or boundaries they explain.
Add presentation flows for the main request path and failure paths the code
supports. Include source evidence and mark inferences.
```

Later, ask it to refresh the diagram when the code changes.
[Full setup guide →](docs/guides/connect-an-ai-agent.md)

## Built with

[React](https://github.com/react/react), [React Flow](https://github.com/xyflow/xyflow),
[Tauri](https://github.com/tauri-apps/tauri), [Simple Icons](https://github.com/simple-icons/simple-icons)
and other open-source projects. Full [credits](docs/reference/third-party.md) and
[licences](THIRD_PARTY_LICENSES.txt).

---

<div align="center">

Free and open source · [Apache 2.0](LICENSE) · [Feedback & ideas](https://github.com/acltabontabon/draft-canvas/issues/new/choose)

</div>
