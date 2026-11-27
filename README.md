<h1 align="center"><img src="www/public/favicon.svg" width="40" height="40" alt="" align="absmiddle">&nbsp;Draft Canvas</h1>

<p align="center">
A diagramming tool for developers to explain how a system works.<br>
Free, open source and local-first: your diagrams stay on your device.
</p>

<!-- release-badges:start -->
<p align="center">
<a href="https://github.com/acltabontabon/draft-canvas/releases/tag/v1.22.0"><img alt="Release v1.22.0" src="https://img.shields.io/badge/release-v1.22.0-0b6e65?style=flat-square"></a>
<a href="https://github.com/acltabontabon/draft-canvas/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI status on main" src="https://img.shields.io/github/actions/workflow/status/acltabontabon/draft-canvas/ci.yml?branch=main&label=CI&style=flat-square"></a>
<a href="https://github.com/acltabontabon/draft-canvas/blob/main/LICENSE"><img alt="Licence: Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-555?style=flat-square"></a>
</p>
<!-- release-badges:end -->

<img width="100%" alt="Draft Canvas in action: sketch an architecture, present a request flow, explore inside a service, and share the diagram." src="docs/media/demo.gif">

## Why Draft Canvas

- **It knows software architecture.** Services, APIs, queues, stores and actors are shapes with meaning,
  and C4 views nest inside each other, from system context down to components.
- **Diagrams you can walk through.** Present a request's path step by step, draw sequence diagrams
  beside the architecture, or take a shape down to see what fails.
- **Your files, on your device.** No account, nothing uploaded. Share a live session when you choose.
- **Your agent, your decisions.** Connect the coding agent you already use. It proposes changes on the
  canvas, and you accept or reject each one.

## Examples

Whole systems from the [starters gallery](https://github.com/acltabontabon/draft-canvas-starters). Open
one from **Starters** in the app, present its flows and step inside its services.

<table>
<tr>
<td colspan="2">
<a href="https://github.com/acltabontabon/draft-canvas-starters/tree/main/starters/examples/food-delivery">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/starter-food-delivery-dark.png">
  <img width="100%" alt="Forkful, a food delivery marketplace, open in Draft Canvas: customer, kitchen and courier apps meet at a junction before the API gateway; ordering, payments, kitchen, logistics, data and notification domains sit inside the system boundary." src="docs/media/starter-food-delivery-light.png">
</picture>
</a>
<p align="center"><b>Food delivery</b><br><sub>An order saga with refunds, an outbox, a dead-letter queue and eight flows to present.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://github.com/acltabontabon/draft-canvas-starters/tree/main/starters/examples/video-streaming">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/starter-video-streaming-dark.png">
  <img width="100%" alt="Reelwave, a video streaming platform, open in Draft Canvas." src="docs/media/starter-video-streaming-light.png">
</picture>
</a>
<p align="center"><b>Video streaming</b><br><sub>An edge inside ISPs, DRM, and a sequence diagram for pressing play.</sub></p>
</td>
<td width="50%" valign="top">
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

Open the [web app](https://app.draftcanvas.dev/): there's nothing to install. For your project folders
and coding agents, [download the desktop app](https://github.com/acltabontabon/draft-canvas/releases/latest)
for macOS or Windows, or install it with Homebrew:

```bash
brew install --cask acltabontabon/tap/draft-canvas
```

Then follow [Getting started](https://draftcanvas.dev/docs/getting-started/), or browse the
[documentation](https://draftcanvas.dev/docs/).

## Map a repository with your agent

In the desktop app, open your project folder, then in **Settings → AI agents** turn on **Allow agent
access**, tick the folder, and click **Add to…** and **Install skill** for your agent (Claude Code,
Codex, Cursor, OpenCode or any MCP client). Start a new agent session and ask:

> Use the Draft Canvas skill to map this repository’s runtime architecture. Verify boundaries and
> connections in source, cite evidence, and mark inferences. Add component views where they explain
> real logic, and presentation flows for verified requests and handled failures. Don’t turn
> dependencies or concurrent effects into an invented execution order. Inspect every view and fix
> readability before finishing; tell me the scope and any unresolved questions.

Ask again when the code changes, and the agent updates the same diagram. See
[Bring your own agent](https://draftcanvas.dev/docs/connect-an-ai-agent/).

## Contributing

Contributions are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues
privately, as described in [SECURITY.md](SECURITY.md). Ideas and feedback go to
[issues](https://github.com/acltabontabon/draft-canvas/issues/new/choose).

Draft Canvas is licensed under [Apache 2.0](LICENSE).
