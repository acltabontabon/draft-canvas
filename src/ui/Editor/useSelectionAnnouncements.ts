import { useEffect } from 'react';
import type { DraftDocument } from '../../document/types';
import { announce } from '../../lib/announce';
import { count } from '../../lib/plural';
import { connectorReading, nodeLookupOf, nodeReading } from '../../nodes/readings';
import { useEditorStore } from '../../store/editorStore';
import { selectEdge, selectNode } from '../../store/selectors';

type Selection = { nodes: readonly string[]; edges: readonly string[] };

/**
 * What a selection change says aloud — `null` for the changes not worth a word (one empty selection
 * replacing another). One shape is read with its kind and how connected it is, one connector as the
 * sentence the canvas draws, anything more as a count.
 */
export function selectionAnnouncement(document: DraftDocument, selection: Selection, previous: Selection): string | null {
  const total = selection.nodes.length + selection.edges.length;
  if (total === 0) return previous.nodes.length + previous.edges.length > 0 ? 'Selection cleared' : null;
  if (total === 1) {
    const nodeId = selection.nodes[0];
    if (nodeId !== undefined) {
      const node = selectNode(document, nodeId);
      if (!node) return null;
      const touching = document.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId).length;
      return `${nodeReading(node)}, ${count(touching, 'connector')}`;
    }
    const edge = selectEdge(document, selection.edges[0]!);
    return edge ? connectorReading(edge, nodeLookupOf(document.nodes)) : null;
  }
  return `${count(total, 'element')} selected`;
}

/**
 * One subscription for the whole canvas, not one per shape: the store is read once per change, and
 * `announce` itself coalesces a burst so arrowing through shapes speaks only where it lands.
 * Presenting is silent — the walkthrough has its own narration (`FlowBar`'s status line).
 */
export function useSelectionAnnouncements(): void {
  useEffect(
    () =>
      useEditorStore.subscribe((state, previous) => {
        if (state.selection === previous.selection || state.mode === 'present') return;
        const text = selectionAnnouncement(state.document, state.selection, previous.selection);
        if (text) announce(text);
      }),
    [],
  );
}
