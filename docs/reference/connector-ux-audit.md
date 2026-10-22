# Connector experience audit

Audited 19 October 2026 against 1.14.0 (`1905d10`).

## Fixed

| Finding | Fix |
| --- | --- |
| Sync/Async controls disagreed | On Service connectors, one store action, `setEdgeInteractionMode`, behind the inspector, context menu and palette. Async hides the reply line and keeps its text |
| Obstacle detours could cross another shape | The router checks whole detour candidates, endpoint legs and corners included, against nearby shapes |
| Labels could cover an unrelated shape | Measured label chips flip sides or slide along the path; canvas and export share the placement |
| Duplicate reconnects failed silently | Rejected drops say **Already connected to that shape.**, add no history, and duplicate targets are left out of the palette |
| Endpoint hit areas shrank at low zoom | The hit ring stays in screen pixels at every zoom, larger for touch |
| No way to bend a connector by hand | Bend handles and **Reset route** |

Regression coverage: [connector unit tests](../../tests/connector-tidiness.test.ts) and
[connector browser tests](../../e2e/connector-tidiness.spec.ts).

## Still open

### Quieter connector inspector

Selecting a connector opens the full inspector at once, and it can cover nearby shapes. Routing is
split: **Route** in the inspector, **Use direct routing** / **Use smart routing** only in the context
menu and palette. Direct routing (route on its own, no bundling) is easy to confuse with Straight.

- Show a compact bar first; expand on request; let the panel close while the connector stays selected.
- Name the connector **From → To**.
- Put routing in one place: **Shape** (Stepped, Curved, Straight) and **Bundling** (Automatic, Independent).
- Place the panel against nearby content, not just the two endpoints.

Source: [`EdgeInspectorPopover.tsx`](../../src/canvas/EdgeInspectorPopover.tsx),
[`registry.ts`](../../src/commands/registry.ts).

### Keyboard endpoints

**Reconnect source…** and **Reconnect target…** in the palette work, but:

- The on-canvas endpoint handles have no role, label or tab stop.
- Palette candidates exclude boundaries, which pointer reconnects accept.
- The palette cannot choose an attachment side.

Proposed: named Source and Target controls with a shape picker and **Automatic / Top / Right /
Bottom / Left**, focus kept on the connector, and the new endpoint announced.

Source: [`DraftEdgeView.tsx`](../../src/canvas/DraftEdgeView.tsx) (`EdgeEndpointHandle`),
`endpointCandidates` in [`registry.ts`](../../src/commands/registry.ts).
