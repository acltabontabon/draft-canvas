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

- Map services, stores, queues, and components while keeping the big picture readable.
- Trace request flows step by step, including happy and failure paths.
- Add notes, source references, and open questions where they belong.
- Start from an architecture pattern, draw from the keyboard, and follow connection suggestions.
- Collaborate live, share protected links, and import or export Mermaid, PlantUML, Structurizr, and
  draw.io diagrams.

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

   > Use the Draft Canvas skill to diagram this repository's architecture as C4 views, down to
   > components where the code has real logic. Read the code before you draw, cite source files
   > and mark anything inferred. Make the main request path a presentation flow, with variants for
   > the failure paths the code handles, and leave open questions as notes. Render every view and
   > fix what reads badly before you finish.

Ask again to refresh the same diagram when the code changes.

---

<div align="center">

[Documentation](https://draftcanvas.dev/docs/) · [Apache 2.0](LICENSE) ·
[Feedback & ideas](https://github.com/acltabontabon/draft-canvas/issues/new/choose)

</div>
