# Roadmap

Shipped work is listed in the [changelog](../../CHANGELOG.md): share links, editable PNG and SVG,
Mermaid import and draw.io export (1.12); flow tracing, the Order processing example, share links
that open at a level or flow, and Arrange selection (1.13); live collaboration, Nodi, and protected
sharing with Guided reader and Focus view (1.16); Traffic (1.17).

## Planned

- **Agent status on desktop Home.** Today Home has **Connect an agent…** and the status bar shows
  **Agents: on** or how many agents are connected. Planned: a Home status line with the last
  request's diagram, and a pending proposal naming its target diagram and room before it is opened.
  The web build keeps no agent UI.
- **Quieter connector inspector.** Open with a compact bar and expand on request, name the connector
  **From → To**, put routing in one place (**Shape** and **Bundling**), and let the panel close while
  the connector stays selected.
- **Keyboard connector endpoints.** The on-canvas endpoint handles have no role, label or tab stop,
  palette reconnect candidates exclude boundaries, and the palette cannot choose an attachment side.
  Planned: named Source and Target controls with **Automatic / Top / Right / Bottom / Left**.
- **Usability observations.** The recorded human sessions in
  [the observation protocol](explanation-usability.md) have not been run.

## Scoped separately, not planned yet

- Code-to-diagram and PR-to-diagram workflows, each with its own provenance rules (what code was
  read, by whom, what was inferred). The client agent reads code; Draft Canvas does not.
