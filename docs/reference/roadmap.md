# Roadmap

Shipped work is listed in the [changelog](../../CHANGELOG.md): share links, editable PNG and SVG,
Mermaid import and draw.io export (1.12); flow tracing, the Order processing example, share links
that open at a level or flow, and Arrange selection (1.13); live collaboration and protected sharing with Guided reader and Focus view (unreleased).

## Planned

- **Agent status on desktop Home.** Today Home has **Connect an agent…** and the status bar shows
  **Agents: on** or how many agents are connected. Planned: a Home status line with the last
  request's diagram, and a pending proposal naming its target diagram and room before it is opened.
  The web build keeps no agent UI.
- **Connector inspector and keyboard endpoints.** Open items from the
  [connector audit](connector-ux-audit.md#still-open).
- **Usability observations.** The recorded human sessions in
  [the observation protocol](explanation-usability.md) have not been run.

## Scoped separately, not planned yet

- Code-to-diagram and PR-to-diagram workflows, each with its own provenance rules (what code was
  read, by whom, what was inferred). The client agent reads code; Draft Canvas does not.
