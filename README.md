<div align="center">

<img src="www/public/favicon.svg" width="64" height="64" alt="">

# Draft Canvas

Draft Canvas is a local-first architecture canvas for developers. Spend more time explaining how
software works and less time making diagrams accurate and tidy. Map systems, trace request flows,
and decide what to build next—with your team.

**Your architecture. Your decisions.** Your diagrams stay on your device, and every proposed change
is yours to review.

</div>

<img width="100%" alt="Draft Canvas in action: sketch an architecture, present a request flow, explore inside a service, and share the diagram." src="docs/media/demo.gif">

## What it can do

- **C4-aware.** System Context, Containers, Components, and nested views.
- **Tech-aware shapes.** Services, APIs, workers, stores, queues, actors, and boundaries.
- **Presentation flows.** Trace and present happy or failure paths.
- **Sequence diagrams.** Lifelines, replies, conditions and loops that lay themselves out, beside the architecture.
- **Bring your own agent.** Connect Claude Code, Codex, Cursor, or any MCP client.
- **Live collaboration.** Share, manage access, and follow presentations.
- **Context for decisions.** Notes, code, sources, and open questions.
- **Import and export.** Import Mermaid and editable files; export images, editable files, Mermaid, PlantUML, Structurizr, and draw.io.

## Examples

Whole systems from the [starters gallery](https://github.com/acltabontabon/draft-canvas-starters), open in Draft Canvas. Load any of them from
**Starters** in the app, present their flows, step inside their services, and make them yours.

<a href="https://github.com/acltabontabon/draft-canvas-starters/tree/main/starters/examples/food-delivery">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/starter-food-delivery-dark.png">
  <img width="100%" alt="Forkful, a food delivery marketplace, open in Draft Canvas: customer, kitchen and courier apps meet at a junction before the API gateway; ordering, payments, kitchen, logistics, data and notification domains sit inside the system boundary." src="docs/media/starter-food-delivery-light.png">
</picture>
</a>

<p align="center"><sub>
<b>Forkful</b>, a food delivery marketplace: an order saga with its refunds, an outbox, a dead-letter
queue and eight flows to present.
</sub></p>

<a href="https://github.com/acltabontabon/draft-canvas-starters/tree/main/starters/examples/video-streaming">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/starter-video-streaming-dark.png">
  <img width="100%" alt="Reelwave, a video streaming platform, open in Draft Canvas: TV, mobile and web apps meet at a junction before the edge gateway; discovery, playback and data domains sit in the cloud, edge appliances inside partner ISPs, and a Press play sequence diagram below." src="docs/media/starter-video-streaming-light.png">
</picture>
</a>

<p align="center"><sub>
<b>Reelwave</b>, a video streaming platform: an edge inside partner ISPs, DRM, a data platform that
retrains recommendations, and a <i>Press play</i> sequence diagram.
</sub></p>

## Get started

Start in the [Draft Canvas web app](https://app.draftcanvas.dev/)—nothing to install—or [download
the desktop app for macOS or Windows](https://github.com/acltabontabon/draft-canvas/releases/latest)
for desktop use and repository access. On macOS, you can also use Homebrew:

```bash
brew install --cask acltabontabon/tap/draft-canvas
```

## Put your repository on the canvas

Open your project folder in Draft Canvas Desktop. In **Settings → AI agents**, turn on **Allow agent
access** and tick the folder. Click **Add to…** for your agent, then **Install skill**. Start a new
agent session and ask:

   > Use the Draft Canvas skill to map this repository’s runtime architecture. Verify boundaries
   > and connections in source, cite evidence, and mark inferences. Add component views where
   > they explain real logic, and presentation flows for verified requests and handled failures.
   > Don’t turn dependencies or concurrent effects into an invented execution order. Inspect every
   > view and fix readability before finishing; tell me the scope and any unresolved questions.

Ask again to refresh the same diagram when the code changes.

---

<div align="center">

[Documentation](https://draftcanvas.dev/docs/) · [Apache 2.0](LICENSE) ·
[Feedback & ideas](https://github.com/acltabontabon/draft-canvas/issues/new/choose)

</div>
