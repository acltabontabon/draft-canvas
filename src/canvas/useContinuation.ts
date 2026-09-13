import { useEffect } from 'react';
import { continuationSets, materialize, type MaterializedContinuation } from '../continuation';
import { lensFlow, useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

/**
 * Keeps `uiStore.continuation` in step with the quiet trigger — a single selected node and
 * nothing else going on. Evaluates only when something that could change the answer changes
 * (a document write, the selected node, a dismissal, a cycle, the gates below); never on pointer
 * movement.
 *
 * What shows is, in order: the alternative the user cycled to (or asked for with `]`) while the
 * anchor's neighborhood is still the one it was chosen in; otherwise the best placeable
 * high-confidence candidate; otherwise nothing. Alternatives are only the candidates that can actually be placed —
 * one with no clear spot would show nothing when cycled to — so each is materialized to find out,
 * and the showing one reuses its result. The rest are ids the pill counts and `]` steps through.
 *
 * Every subscription is a primitive (or a store-owned object replaced only on change) so this
 * re-runs, and re-renders its host, only when one of them actually flips — the house rule from
 * `DraftNodeView.tsx`. `setContinuation` keeps the previous offer object when the answer is the
 * same, so a ghost's identity survives unrelated edits elsewhere.
 *
 * A drag or resize only hides the offer: the user's cycled choice is kept, and is dropped anyway
 * if the gesture really changed the anchor's neighborhood.
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
      if (!interactionActive) ui.setContinuationCycle(null);
      return;
    }
    const doc = useEditorStore.getState().document;
    const { quiet: suggested, explicit } = continuationSets(doc, anchorId, { dismissed: dismissals, recent });
    const best = suggested[0];
    const wantsCycle = cycle !== null && cycle.anchorId === anchorId;
    if (!best && !wantsCycle) {
      if (cycle) ui.setContinuationCycle(null);
      ui.setContinuation(null);
      return;
    }
    const placed = new Map<string, MaterializedContinuation>();
    for (const candidate of explicit) {
      const materialized = materialize(doc, candidate);
      if (materialized) placed.set(candidate.id, materialized);
    }
    const chosen =
      wantsCycle && explicit.some((c) => c.id === cycle.candidateId && c.neighborhoodKey === cycle.neighborhoodKey)
        ? placed.get(cycle.candidateId)
        : undefined;
    // A choice made in a neighborhood that has since changed no longer means anything.
    if (cycle && !chosen) ui.setContinuationCycle(null);
    // The best suggestion that has somewhere to go — the one a crowded canvas can't fit is skipped.
    const offer = chosen ?? suggested.map((candidate) => placed.get(candidate.id)).find((m) => m !== undefined);
    ui.setContinuation(offer ? { ...offer, trigger: 'select', alternatives: [...placed.keys()] } : null);
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

/**
 * Whether this node is one an accepted continuation just created, so its view can play the
 * one-shot "settle" (ghost → real). The store expires the marker (`setSettleNodeIds`), not the
 * view — a node undone before its animation ends must not replay it when redone.
 */
export function useSettle(id: string): boolean {
  return useUiStore((state) => state.settleNodeIds.includes(id));
}
