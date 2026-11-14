import { memo, useMemo, useRef, useState } from 'react';
import { pathKey } from '../depth/tree';
import type { DraftEdge, DraftNode } from '../document/types';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { usePersonality } from '../theme/usePersonality';
import { useThemeValue } from '../theme/useTheme';
import { agentGhostDiff, changedBeyondPlace, movedShapes, type AgentGhostDiff, type MovedShape } from './agentGhostDiff';
import { GhostEdge, GhostNode } from './ContinuationGhost';
import { ghostGraph, ghostRouteFor } from './ghostRoutes';

interface PreviewSource {
  path: readonly string[];
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
  /** What the change was worked out from, when that isn't the view on screen (see `AgentPreview`). */
  base?: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] };
}

/**
 * An AI agent's change to the diagram on screen, while it is still being prepared: only what it adds
 * or changes, drawn on top in flow space (inside `Canvas`'s `<ViewportLayer>`, so it pans and zooms
 * with the diagram) with the same `describeNode`/`edgeRoutes` pipeline as the real thing, at a
 * ghost's opacity inside a dashed outline — and what it removes, crossed out where it stands.
 *
 * Provisional in every way that matters: never part of the document, its history or autosave (the
 * store's `agentPreview` is set and cleared by the desktop's agent activity alone), pointer-transparent,
 * and gone the moment the change is committed — when the real shapes appear exactly where this
 * showed them — or dropped. The person keeps editing underneath; a change of theirs meanwhile turns
 * the agent's commit into a conflict, never an overwrite.
 */
export const AgentPreviewLayer = memo(function AgentPreviewLayer() {
  const preview = useUiStore((state) => state.agentPreview);
  const path = useEditorStore((state) => state.path);
  if (!preview || pathKey(preview.path as string[]) !== pathKey(path)) return null;
  return <PreviewBody preview={preview} source="live" label="Agent’s proposed change" />;
});

/**
 * A pending proposal's reviewed result, drawn the same way as `AgentPreviewLayer` while
 * `ProposalPanel` shows it — set by the panel itself (`ProposalDetail`, from the exact dry-run
 * result the text diff already computed), independent of any live-write activity, and gone the
 * moment the panel's toggle is off, the proposal is resolved, or the room/document changes.
 */
export const ProposalPreviewLayer = memo(function ProposalPreviewLayer() {
  const preview = useUiStore((state) => state.proposalPreview);
  const path = useEditorStore((state) => state.path);
  if (!preview || !preview.visible || pathKey(preview.path as string[]) !== pathKey(path)) return null;
  return <PreviewBody preview={preview} source="proposal" label="Proposal’s previewed change" />;
});

/**
 * What Tidy up would do, before it is applied (`uiStore.tidyPreview`, set by the Tidy up command and
 * cleared by `TidyBar`). Always the tracing sheet, even when no shape moves: a cleanup that only
 * re-attaches connectors drawn as ghosts over the live ones would show every changed line twice,
 * and the question being asked is "is this the picture I want", which the whole result answers.
 */
export const TidyPreviewLayer = memo(function TidyPreviewLayer() {
  const preview = useUiStore((state) => state.tidyPreview);
  const path = useEditorStore((state) => state.path);
  // Only over the very room it was worked out from: `TidyBar` drops a stale preview a render later,
  // and for that render the sheet must not show a cleanup of a diagram that has since changed.
  const current = useEditorStore((state) => preview !== null && state.document === preview.base);
  const source = useMemo(
    () => preview && { path: preview.path, nodes: preview.view.nodes, edges: preview.view.edges, base: { nodes: preview.base.nodes, edges: preview.base.edges } },
    [preview],
  );
  if (!source || !current || pathKey(source.path as string[]) !== pathKey(path)) return null;
  return <PreviewBody preview={source} source="tidy" label="Tidy up preview" sheet />;
});

/**
 * What Arrange would do, before it is applied (`uiStore.arrangePreview`, set by the Arrange commands
 * and cleared by `ArrangeBar`): the arrangement for the reading direction shown, on the same tracing
 * sheet Tidy up's preview uses — the whole result is the question, more so for a room laid out again.
 *
 * The result alone, unless asked (`ArrangeShow`): a re-layout moves everything, and an outline and a
 * trail for every shape competed with the drawing being judged. One shape's move shows when it is
 * pointed at, clicked or selected; `moves` shows them all; `before` takes the sheet away.
 */
export const ArrangePreviewLayer = memo(function ArrangePreviewLayer() {
  const preview = useUiStore((state) => state.arrangePreview);
  const path = useEditorStore((state) => state.path);
  const current = useEditorStore((state) => preview !== null && state.document === preview.base);
  const view = preview?.options[preview.direction];
  const source = useMemo(
    () => preview && view && { path: preview.path, nodes: view.nodes, edges: view.edges, base: { nodes: preview.base.nodes, edges: preview.base.edges } },
    [preview, view],
  );
  // What this arrangement fixes (`ArrangePreview.fixes`) is inked like a change, so the correction
  // can be found in a drawing where everything else merely moved.
  const fixes = preview?.fixes?.[preview.direction];
  const marked = useMemo(() => new Set((fixes ?? []).map((fix) => fix.id).filter(Boolean)), [fixes]);
  if (!source || !current || preview?.show === 'before' || pathKey(source.path as string[]) !== pathKey(path)) return null;
  return <PreviewBody preview={source} source="tidy" label="Arrange preview" sheet trails={preview?.show === 'moves' ? 'all' : 'picked'} marked={marked} />;
});

type PreviewOrigin = 'live' | 'proposal' | 'tidy';

/** Which moved shapes trail back to where they stand now: every one, or only those picked out. */
type Trails = 'all' | 'picked';

function PreviewBody({
  preview,
  source,
  label,
  sheet = false,
  trails = 'all',
  marked,
}: {
  preview: PreviewSource;
  source: PreviewOrigin;
  label: string;
  sheet?: boolean;
  trails?: Trails;
  /** Shapes and connectors to ink as changed whatever the diff says of them. */
  marked?: ReadonlySet<string>;
}) {
  const theme = useThemeValue();
  const { preset } = usePersonality();
  const liveNodes = useEditorStore((state) => state.document.nodes);
  const liveEdges = useEditorStore((state) => state.document.edges);
  // An agent's live change is told apart from the view it read, not the one on screen: the person
  // keeps editing meanwhile, and what they add is no part of the agent's change — diffed against the
  // screen it showed as something the agent removes. A proposal is worked out on the view on screen.
  const nodes = preview.base?.nodes ?? liveNodes;
  const edges = preview.base?.edges ?? liveEdges;

  const diff = useMemo(() => agentGhostDiff({ nodes, edges }, { nodes: preview.nodes, edges: preview.edges }), [nodes, edges, preview]);
  const changedGroups = useMemo(() => [...diff.addedGroups, ...diff.modifiedGroups], [diff]);
  const changedNodes = useMemo(() => [...diff.addedNodes, ...diff.modifiedNodes], [diff]);
  const changedEdges = useMemo(() => [...diff.addedEdges, ...diff.modifiedEdges], [diff]);
  const removedShapes = useMemo(() => [...diff.removedNodes, ...diff.removedGroups], [diff]);

  // Routed the way the canvas will route them (`ghostRoutes.ts`): what the change adds or rewires
  // through the state it leads to — lanes beside its siblings, trunks, bends, the reply line — and
  // what it removes through the state on screen now, the only one its endpoints still exist in.
  const after = useMemo(() => ghostGraph(preview.nodes, preview.edges), [preview.nodes, preview.edges]);
  const before = useMemo(() => ghostGraph(nodes, edges), [nodes, edges]);
  const bounds = useMemo(() => boundsOf([...changedNodes, ...changedGroups, ...removedShapes]), [changedNodes, changedGroups, removedShapes]);
  const moved = useMemo(() => movedShapes({ nodes, edges }, { nodes: preview.nodes, edges: preview.edges }), [nodes, edges, preview]);
  const base = useMemo(() => ({ nodes, edges }), [nodes, edges]);

  if (sheet || moved.length > 0) {
    return <TracingSheet preview={preview} source={source} base={base} diff={diff} moved={moved} after={after} before={before} trails={trails} marked={marked} />;
  }

  return (
    <div className="dc-ghost dc-agent-preview" data-source={source} aria-hidden="true">
      {bounds && (
        <div className="dc-agent-preview-tag" style={{ transform: `translate(${bounds.x}px, ${bounds.y - 28}px)` }}>
          {label}
        </div>
      )}
      {/* A boundary the change grows, at the size it will have — so what joins it reads as inside. */}
      {changedGroups.map((group) => (
        <div
          key={`group-${group.id}`}
          className="dc-agent-preview-group"
          style={{ transform: `translate(${group.x}px, ${group.y}px)`, width: group.width, height: group.height }}
        >
          {group.text && <span className="dc-agent-preview-group-label">{group.text}</span>}
        </div>
      ))}
      {/* A shape (plain or boundary) the change removes, crossed out where it stands until it's gone. */}
      {removedShapes.map((node) => (
        <div
          key={`gone-${node.id}`}
          className="dc-agent-preview-removed"
          style={{ transform: `translate(${node.x - 4}px, ${node.y - 4}px)`, width: node.width + 8, height: node.height + 8 }}
        />
      ))}
      <svg className="dc-ghost-edges" width={1} height={1} aria-hidden="true" focusable="false">
        {diff.removedEdges.map((edge: DraftEdge) => {
          const route = ghostRouteFor(before, edge);
          return route && <GhostEdge key={edge.id} edge={edge} {...route} removed />;
        })}
        <g data-ink="new">
          {changedEdges.map((edge: DraftEdge) => {
            const route = ghostRouteFor(after, edge);
            return route && <GhostEdge key={edge.id} edge={edge} {...route} />;
          })}
        </g>
      </svg>
      {changedNodes.map((node) => (
        <GhostNode key={node.id} node={node} theme={theme} preset={preset} />
      ))}
    </div>
  );
}

function boundsOf(nodes: readonly DraftNode[]): { x: number; y: number } | null {
  if (!nodes.length) return null;
  return { x: Math.min(...nodes.map((n) => n.x)), y: Math.min(...nodes.map((n) => n.y)) };
}

/** How a shape on the tracing sheet is inked: new, changed, or as it already is. */
type Ink = 'new' | 'changed' | 'plain';

/**
 * A change that moves shapes, shown as tracing paper laid over the diagram: the current drawing sinks
 * behind a translucent sheet (`canvas.css` fades the real layers while one is up), and the whole
 * diagram the change leads to is drawn on it, what is new or changed in teal ink. A moved shape leaves
 * a dotted trail back to a faint outline where it stands now, so a tidy-up reads as motion, not as
 * every shape drawn twice; a removed one is hatched out where it stands.
 */
function TracingSheet({
  preview,
  source,
  base,
  diff,
  moved,
  after,
  before,
  trails,
  marked,
}: {
  preview: PreviewSource;
  source: PreviewOrigin;
  base: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] };
  diff: AgentGhostDiff;
  moved: MovedShape[];
  after: ReturnType<typeof ghostGraph>;
  before: ReturnType<typeof ghostGraph>;
  trails: Trails;
  marked?: ReadonlySet<string>;
}) {
  const theme = useThemeValue();
  const { preset } = usePersonality();
  // With trails on request, the ones shown: the shape under the pointer, one clicked to keep its
  // trail up (clicked again, or another, to let it go), and whatever is selected in the diagram.
  const picking = trails === 'picked';
  const selected = useEditorStore((state) => state.selection.nodes);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const trailed = useMemo(
    () => (picking ? moved.filter(({ node }) => node.id === hovered || node.id === pinned || selected.includes(node.id)) : moved),
    [picking, moved, hovered, pinned, selected],
  );
  const movedIds = useMemo(() => new Set(moved.map(({ node }) => node.id)), [moved]);
  // Teal is for what the change really alters. A shape that only moves is drawn plain, its trail says
  // it moved: on a re-layout everything moves, and inking it all would leave nothing standing out.
  const inkOf = useMemo(() => {
    const ink = new Map<string, Ink>();
    const wasNode = new Map(base.nodes.map((n) => [n.id, n]));
    const wasEdge = new Map(base.edges.map((e) => [e.id, e]));
    for (const n of [...diff.addedNodes, ...diff.addedGroups]) ink.set(n.id, 'new');
    for (const n of [...diff.modifiedNodes, ...diff.modifiedGroups]) {
      const was = wasNode.get(n.id);
      if (!was || changedBeyondPlace(was, n)) ink.set(n.id, 'changed');
    }
    for (const e of diff.addedEdges) ink.set(e.id, 'new');
    for (const e of diff.modifiedEdges) {
      const was = wasEdge.get(e.id);
      if (!was || changedBeyondPlace(was, e)) ink.set(e.id, 'changed');
    }
    for (const id of marked ?? []) if (!ink.has(id)) ink.set(id, 'changed');
    return (id: string): Ink => ink.get(id) ?? 'plain';
  }, [diff, base, marked]);
  const groups = preview.nodes.filter((n) => n.type === 'group');
  const shapes = preview.nodes.filter((n) => n.type !== 'group');
  const removed = [...diff.removedNodes, ...diff.removedGroups];

  return (
    <div className="dc-ghost dc-agent-preview" data-mode="sheet" data-source={source} data-many={trailed.length > 3 ? 'true' : undefined} data-pick={picking ? 'true' : undefined} aria-hidden="true">
      {/* No tag: the sheet itself says this is the proposal, and a tag would sit over what moved. */}
      <div className="dc-preview-sheet" />
      {/* Where each moved shape stands now, faint, and the trail to where it goes. */}
      {trailed.map(({ node, from }) => (
        <div key={`was-${node.id}`} className="dc-preview-was" style={{ transform: `translate(${from.x}px, ${from.y}px)`, width: from.width, height: from.height }} />
      ))}
      <svg className="dc-preview-trails" width={1} height={1} aria-hidden="true" focusable="false">
        {trailed.map(({ node, from }) => (
          <g key={`trail-${node.id}`}>
            <line x1={from.x + from.width / 2} y1={from.y + from.height / 2} x2={node.x + node.width / 2} y2={node.y + node.height / 2} />
            <circle cx={from.x + from.width / 2} cy={from.y + from.height / 2} r={3} />
          </g>
        ))}
      </svg>
      {removed.map((node) => (
        <div
          key={`gone-${node.id}`}
          className="dc-agent-preview-removed"
          style={{ transform: `translate(${node.x - 4}px, ${node.y - 4}px)`, width: node.width + 8, height: node.height + 8 }}
        />
      ))}
      {groups.map((group) => (
        <div
          key={`group-${group.id}`}
          className="dc-agent-preview-group"
          data-ink={inkOf(group.id)}
          style={{ transform: `translate(${group.x}px, ${group.y}px)`, width: group.width, height: group.height }}
        >
          {group.text && <span className="dc-agent-preview-group-label">{group.text}</span>}
        </div>
      ))}
      <svg className="dc-ghost-edges" width={1} height={1} aria-hidden="true" focusable="false">
        {diff.removedEdges.map((edge: DraftEdge) => {
          const route = ghostRouteFor(before, edge);
          return route && <GhostEdge key={edge.id} edge={edge} {...route} removed />;
        })}
        {preview.edges.map((edge) => {
          const route = ghostRouteFor(after, edge);
          return (
            route && (
              <g key={edge.id} data-ink={inkOf(edge.id)}>
                <GhostEdge edge={edge} {...route} />
              </g>
            )
          );
        })}
      </svg>
      {shapes.map((node) => {
        const pickable = picking && movedIds.has(node.id);
        return (
          <div
            key={node.id}
            className="dc-preview-ink"
            data-ink={inkOf(node.id)}
            data-moved={pickable ? 'true' : undefined}
            data-picked={pickable && node.id === pinned ? 'true' : undefined}
            onPointerEnter={pickable ? () => setHovered(node.id) : undefined}
            onPointerLeave={pickable ? () => setHovered((id) => (id === node.id ? null : id)) : undefined}
            onPointerDown={pickable ? (event) => { pressed.current = { x: event.clientX, y: event.clientY }; } : undefined}
            onClick={pickable ? (event) => {
              // A pan that began on the shape ends in a click too: only a press that stayed put picks.
              const from = pressed.current;
              if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > 4) return;
              setPinned((id) => (id === node.id ? null : node.id));
            } : undefined}
          >
            <GhostNode node={node} theme={theme} preset={preset} />
          </div>
        );
      })}
    </div>
  );
}
