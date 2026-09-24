import { memo, useMemo } from 'react';
import { pathKey } from '../depth/tree';
import type { DraftEdge, DraftNode } from '../document/types';
import { rectOf } from '../edges/routing';
import { useEditorStore } from '../store/editorStore';
import { useUiStore, type AgentPreview } from '../store/uiStore';
import { usePersonality } from '../ui/personality/usePersonality';
import { useThemeValue } from '../ui/theme/useTheme';
import { GhostEdge, GhostNode } from './ContinuationGhost';

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
  return <PreviewBody preview={preview} />;
});

function PreviewBody({ preview }: { preview: AgentPreview }) {
  const theme = useThemeValue();
  const { preset } = usePersonality();
  const nodes = useEditorStore((state) => state.document.nodes);
  const edges = useEditorStore((state) => state.document.edges);

  const diff = useMemo(() => {
    const before = new Map(nodes.map((n) => [n.id, n]));
    const beforeEdges = new Map(edges.map((e) => [e.id, e]));
    const after = new Set(preview.nodes.map((n) => n.id));
    const changedNodes = preview.nodes.filter((n) => {
      const was = before.get(n.id);
      return !was || was.x !== n.x || was.y !== n.y || was.width !== n.width || was.height !== n.height || was.text !== n.text || was.type !== n.type;
    });
    const changedEdges = preview.edges.filter((e) => {
      const was = beforeEdges.get(e.id);
      return !was || was.label !== e.label || JSON.stringify([was.sourceAnchor, was.targetAnchor]) !== JSON.stringify([e.sourceAnchor, e.targetAnchor]);
    });
    const removed = nodes.filter((n) => !after.has(n.id) && n.type !== 'group');
    return { changedNodes, changedEdges, removed };
  }, [nodes, edges, preview]);

  const endpoints = useMemo(() => new Map<string, DraftNode>(preview.nodes.map((n) => [n.id, n])), [preview.nodes]);
  const obstacleRects = useMemo(() => preview.nodes.filter((n) => n.type !== 'group').map((n) => ({ id: n.id, rect: rectOf(n) })), [preview.nodes]);
  const bounds = useMemo(() => boundsOf([...diff.changedNodes, ...diff.removed]), [diff]);

  return (
    <div className="dc-ghost dc-agent-preview" aria-hidden="true">
      {bounds && (
        <div className="dc-agent-preview-tag" style={{ transform: `translate(${bounds.x}px, ${bounds.y - 28}px)` }}>
          Agent’s proposed change
        </div>
      )}
      {/* A boundary the change grows, at the size it will have — so what joins it reads as inside. */}
      {diff.changedNodes
        .filter((node) => node.type === 'group')
        .map((group) => (
          <div
            key={`group-${group.id}`}
            className="dc-agent-preview-group"
            style={{ transform: `translate(${group.x}px, ${group.y}px)`, width: group.width, height: group.height }}
          />
        ))}
      {diff.removed.map((node) => (
        <div
          key={`gone-${node.id}`}
          className="dc-agent-preview-removed"
          style={{ transform: `translate(${node.x - 4}px, ${node.y - 4}px)`, width: node.width + 8, height: node.height + 8 }}
        />
      ))}
      <svg className="dc-ghost-edges" width={1} height={1} aria-hidden="true" focusable="false">
        {diff.changedEdges.map((edge: DraftEdge) => (
          <GhostEdge key={edge.id} edge={edge} endpoints={endpoints} obstacleRects={obstacleRects} />
        ))}
      </svg>
      {diff.changedNodes
        .filter((node) => node.type !== 'group')
        .map((node) => (
          <GhostNode key={node.id} node={node} theme={theme} preset={preset} />
        ))}
    </div>
  );
}

function boundsOf(nodes: readonly DraftNode[]): { x: number; y: number } | null {
  if (!nodes.length) return null;
  return { x: Math.min(...nodes.map((n) => n.x)), y: Math.min(...nodes.map((n) => n.y)) };
}
