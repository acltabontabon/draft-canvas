import { useEffect } from 'react';
import { continuationsFor, materialize } from '../continuation';
import { lensFlow, useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

/**
 * Keeps `uiStore.continuation` in step with the quiet trigger — a single selected node and
 * nothing else going on. Evaluates only when something that could change the answer changes
 * (a document write, the selected node, a dismissal, a cycle, the gates below); never on pointer
 * movement.
 *
 * What shows is, in order: the alternative the user cycled to (or asked for with `]`) while the
 * anchor's neighborhood is still the one it was chosen in; otherwise the best high-confidence
 * candidate; otherwise nothing. Only the showing candidate is materialized — the rest are ids
 * the pill counts and `]` steps through.
 *
 * Every subscription is a primitive (or a store-owned object replaced only on change) so this
 * re-runs, and re-renders its host, only when one of them actually flips — the house rule from
 * `DraftNodeView.tsx`. `setContinuation` keeps the previous offer object when the answer is the
 * same, so a ghost's identity survives unrelated edits elsewhere.
 *
 * Offers made by the explicit trigger — a connector dropped on empty canvas — belong to the
 * Quick Connect menu while it is open; this hook leaves those alone.
 */
export function useContinuation(interactive: boolean): void {
  const revision = useEditorStore((state) => state.revision);
  const anchorId = useEditorStore((state) =>
    state.selection.nodes.length === 1 && state.selection.edges.length === 0 ? state.selection.nodes[0]! : null,
  );
  const focusActive = useEditorStore((state) => state.focus.active);
  const playbackActive = useEditorStore((state) => state.flowPlayback.active);
  const lensActive = useEditorStore((state) => lensFlow(state) !== undefined);
  const enabled = useUiStore((state) => state.continuationsEnabled);
  const dismissals = useUiStore((state) => state.continuationDismissals);
  const cycle = useUiStore((state) => state.continuationCycle);
  const recent = useUiStore((state) => state.continuationRecent);
  const interactionActive = useUiStore((state) => state.interactionActive);
  const quickConnectOpen = useUiStore((state) => state.quickConnect !== null);

  useEffect(() => {
    const ui = useUiStore.getState();
    if (ui.continuation?.trigger === 'drop') return;
    const quiet =
      enabled && interactive && anchorId && !focusActive && !playbackActive && !lensActive && !interactionActive && !quickConnectOpen;
    if (!quiet) {
      ui.setContinuation(null);
      ui.setContinuationCycle(null);
      return;
    }
    const doc = useEditorStore.getState().document;
    const [best] = continuationsFor(doc, anchorId, 'select', { dismissed: dismissals, recent });
    const wantsCycle = cycle !== null && cycle.anchorId === anchorId;
    if (!best && !wantsCycle) {
      if (cycle) ui.setContinuationCycle(null);
      ui.setContinuation(null);
      return;
    }
    const explicit = continuationsFor(doc, anchorId, 'invoke', { recent });
    const chosen = wantsCycle
      ? explicit.find((c) => c.id === cycle.candidateId && c.neighborhoodKey === cycle.neighborhoodKey)
      : undefined;
    // A choice made in a neighborhood that has since changed no longer means anything.
    if (cycle && !chosen) ui.setContinuationCycle(null);
    const showing = chosen ?? best;
    const offer = showing ? materialize(doc, showing) : undefined;
    ui.setContinuation(offer ? { ...offer, trigger: 'select', alternatives: explicit.map((c) => c.id) } : null);
  }, [
    revision,
    anchorId,
    focusActive,
    playbackActive,
    lensActive,
    enabled,
    dismissals,
    cycle,
    recent,
    interactionActive,
    quickConnectOpen,
    interactive,
  ]);
}

/** How long a settled node keeps its one-shot marker — just past the 180 ms animation. */
const SETTLE_MS = 240;

/**
 * Whether this node is one an accepted continuation just created, so its view can play the
 * one-shot "settle" (ghost → real). Clears its own marker a beat later — the same one-shot shape
 * as `jumpFlashId`, per node so a fragment's nodes never cut each other short.
 */
export function useSettle(id: string): boolean {
  const settling = useUiStore((state) => state.settleNodeIds.includes(id));
  useEffect(() => {
    if (!settling) return;
    const timeout = window.setTimeout(() => useUiStore.getState().clearSettleNode(id), SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, [settling, id]);
  return settling;
}
