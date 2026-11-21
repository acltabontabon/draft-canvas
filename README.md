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

<table>
<tr>
<td width="33%" valign="top">
<a href="https://github.com/acltabontabon/draft-canvas-starters/tree/main/starters/examples/food-delivery">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/starter-food-delivery-dark.png">
  <img width="100%" alt="Forkful, a food delivery marketplace, open in Draft Canvas." src="docs/media/starter-food-delivery-light.png">
</picture>
</a>
<p align="center"><b>Food delivery</b><br><sub>An order saga with refunds, an outbox and a dead-letter queue.</sub></p>
</td>
<td width="33%" valign="top">
<a href="https://github.com/acltabontabon/draft-canvas-starters/tree/main/starters/examples/video-streaming">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/starter-video-streaming-dark.png">
  <img width="100%" alt="Reelwave, a video streaming platform, open in Draft Canvas." src="docs/media/starter-video-streaming-light.png">
</picture>
</a>
<p align="center"><b>Video streaming</b><br><sub>An edge inside ISPs, DRM, and a Press play sequence diagram.</sub></p>
</td>
<td width="33%" valign="top">
<a href="https://github.com/acltabontabon/draft-canvas-starters/tree/main/starters/examples/ride-hailing">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/starter-ride-hailing-dark.png">
  <img width="100%" alt="Swiftride, a ride-hailing platform, open in Draft Canvas." src="docs/media/starter-ride-hailing-light.png">
</picture>
</a>
<p align="center"><b>Ride-hailing</b><br><sub>Live driver locations, dispatch, surge pricing and payouts.</sub></p>
</td>
</tr>
</table>

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
