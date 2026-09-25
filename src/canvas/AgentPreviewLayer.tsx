import { memo, useMemo } from 'react';
import { pathKey } from '../depth/tree';
import type { DraftEdge, DraftNode } from '../document/types';
import { rectOf } from '../edges/routing';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { usePersonality } from '../ui/personality/usePersonality';
import { useThemeValue } from '../ui/theme/useTheme';
import { agentGhostDiff } from './agentGhostDiff';
import { GhostEdge, GhostNode } from './ContinuationGhost';

interface PreviewSource {
  path: readonly string[];
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
}

/**
 * An AI agent's change to the diagram on screen, while it is still being prepared: only what it adds
 * or changes, drawn on top in flow space (inside `Canvas`'s `<ViewportPortal>`, so it pans and zooms
 * with the diagram) with the same `describeNode`/`routeBetween` pipeline as the real thing, at a
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
  return <PreviewBody preview={preview} label="Agent’s proposed change" />;
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
  return <PreviewBody preview={preview} label="Proposal’s previewed change" />;
});

function PreviewBody({ preview, label }: { preview: PreviewSource; label: string }) {
  const theme = useThemeValue();
  const { preset } = usePersonality();
  const nodes = useEditorStore((state) => state.document.nodes);
  const edges = useEditorStore((state) => state.document.edges);

  const diff = useMemo(() => agentGhostDiff({ nodes, edges }, { nodes: preview.nodes, edges: preview.edges }), [nodes, edges, preview]);
  const changedGroups = useMemo(() => [...diff.addedGroups, ...diff.modifiedGroups], [diff]);
  const changedNodes = useMemo(() => [...diff.addedNodes, ...diff.modifiedNodes], [diff]);
  const changedEdges = useMemo(() => [...diff.addedEdges, ...diff.modifiedEdges], [diff]);
  const removedShapes = useMemo(() => [...diff.removedNodes, ...diff.removedGroups], [diff]);

  // The before-state first, so a removed edge's endpoints (which only exist there) still resolve,
  // then the after-state on top for anything added, modified, or unaffected.
  const endpoints = useMemo(() => {
    const byId = new Map<string, DraftNode>(nodes.map((n) => [n.id, n]));
    for (const n of preview.nodes) byId.set(n.id, n);
    return byId;
  }, [nodes, preview.nodes]);
  const obstacleRects = useMemo(() => preview.nodes.filter((n) => n.type !== 'group').map((n) => ({ id: n.id, rect: rectOf(n) })), [preview.nodes]);
  const bounds = useMemo(() => boundsOf([...changedNodes, ...changedGroups, ...removedShapes]), [changedNodes, changedGroups, removedShapes]);

  return (
    <div className="dc-ghost dc-agent-preview" aria-hidden="true">
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
        />
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
        {diff.removedEdges.map((edge: DraftEdge) => (
          <GhostEdge key={edge.id} edge={edge} endpoints={endpoints} obstacleRects={obstacleRects} removed />
        ))}
        {changedEdges.map((edge: DraftEdge) => (
          <GhostEdge key={edge.id} edge={edge} endpoints={endpoints} obstacleRects={obstacleRects} />
        ))}
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
