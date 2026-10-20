<div align="center">

<img src="www/public/favicon.svg" width="64" height="64" alt="">

# Draft Canvas

### Draw software. Explain how it works.

A local-first canvas for turning software architecture into a clear visual story.<br>
Sketch an idea. Explore the detail. Walk through the flow.

**[Try it in your browser](https://acltabontabon.com/draft-canvas/editor/)** ·
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

Use the [web editor](https://acltabontabon.com/draft-canvas/editor/), or download the desktop app for
macOS or Windows from the [latest release](https://github.com/acltabontabon/draft-canvas/releases/latest).
On a Mac you can also install it with Homebrew:

```bash
brew install --cask acltabontabon/tap/draft-canvas
```

See the [desktop guide](docs/guides/desktop.md#installing) for first-launch steps, and
[Contributing](CONTRIBUTING.md) to build and run it from source.

## From codebase to canvas

**Your code already tells a story. See it drawn.**

Connect Claude Code, Codex or Cursor to **Draft Canvas Desktop**. The **Draft Canvas skill** helps
your agent turn an existing project into a diagram you can explore, edit and present.

![An architecture diagram made with the Draft Canvas skill, showing a storefront, its services, databases and an order flow.](docs/media/guides/agent-skill-example.png)

### 1. Connect your agent

Open your project folder in Draft Canvas Desktop, then go to **Settings → AI agents**:

- Turn on **Allow agent access** and tick your project folder.
- Choose your agent under **Connect an agent** and follow the setup.

### 2. Install the skill

In the same settings, click **Agent skill → Install skill**.
Keep Draft Canvas running and start a new agent session in your repository.

### 3. Ask for your first diagram

Copy this into your agent:

```text
Use the Draft Canvas skill to draw the architecture of this repository.
Use appropriate C4 views, meaningful grouping boundaries, and look-inside
details for key services. Attach decision notes, open questions and relevant
code snippets to the shapes, connectors or boundaries they explain.
Add presentation flows for the main request path and failure paths the code
supports. Include source evidence and mark inferences.
```

**Explore it.** Look inside services for detail, play the flow, or edit the diagram yourself.

**Keep it current.** Ask: “Refresh this Draft Canvas diagram to match the current code.”

[Full setup guide →](docs/guides/connect-an-ai-agent.md) · [Read the skill →](skills/draft-canvas/SKILL.md)

## Acknowledgements

Draft Canvas is built on [React](https://github.com/react/react), [React Flow](https://github.com/xyflow/xyflow),
[Tauri](https://github.com/tauri-apps/tauri), [Simple Icons](https://github.com/simple-icons/simple-icons)
and other open-source work. See the [third-party credits](docs/reference/third-party.md) and the
[license notices](THIRD_PARTY_LICENSES.txt), also in the app under **About → Licences**.

---

<div align="center">

Free and open source · [Apache 2.0](LICENSE) · [Feedback & ideas](https://github.com/acltabontabon/draft-canvas/issues/new/choose)

</div>
