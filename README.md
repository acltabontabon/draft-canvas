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
- **Draw with your coding agent.** Connect an MCP-compatible agent to the desktop app to create and revise diagrams.

## Local by default. Yours to keep.

No account, no backend, no diagram uploads. The web app saves in your browser and works offline once loaded.
The desktop app keeps diagrams as ordinary files on your computer, with a Quick Draft a click away in the menu bar or system tray.

Move between them with a `.draftcanvas` file. Export browser diagrams you want to keep backed up.
Optional coding agents use their own AI providers.

## Running it yourself

Serve the web app with Docker:

```bash
docker run -d --name draft-canvas -p 8080:8080 acltabontabon/draft-canvas
```

Open `http://localhost:8080`. Use HTTPS when hosting for others to enable offline support.

For local development, setup and checks, see [Contributing](CONTRIBUTING.md).

---

<div align="center">

Free and open source · [Apache 2.0](LICENSE) · [Feedback & ideas](https://github.com/acltabontabon/draft-canvas/issues/new/choose)

</div>
