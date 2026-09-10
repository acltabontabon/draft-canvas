import { useEffect } from 'react';
import { continuationsFor, materialize } from '../continuation';
import { lensFlow, useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

/**
 * Keeps `uiStore.continuation` in step with the quiet trigger — a single selected node and
 * nothing else going on. Evaluates only when something that could change the answer changes
 * (a document write, the selected node, a dismissal, the gates below); never on pointer movement.
 *
 * Every subscription is a primitive so this re-runs, and re-renders its host, only when one of
 * them actually flips — the house rule from `DraftNodeView.tsx`. The whole evaluation is one
 * `neighborhoodOf` scan plus a placement, and `setContinuation` keeps the previous offer object
 * when the answer is the same, so a ghost's identity survives unrelated edits elsewhere.
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
  const interactionActive = useUiStore((state) => state.interactionActive);
  const quickConnectOpen = useUiStore((state) => state.quickConnect !== null);

  useEffect(() => {
    const ui = useUiStore.getState();
    if (ui.continuation?.trigger === 'drop') return;
    const quiet =
      enabled && interactive && anchorId && !focusActive && !playbackActive && !lensActive && !interactionActive && !quickConnectOpen;
    if (!quiet) {
      ui.setContinuation(null);
      return;
    }
    const doc = useEditorStore.getState().document;
    const [first] = continuationsFor(doc, anchorId, 'select', dismissals);
    const offer = first ? materialize(doc, first) : undefined;
    ui.setContinuation(offer ? { ...offer, trigger: 'select' } : null);
  }, [
    revision,
    anchorId,
    focusActive,
    playbackActive,
    lensActive,
    enabled,
    dismissals,
    interactionActive,
    quickConnectOpen,
    interactive,
  ]);
}

/** How long a settled node keeps its one-shot marker — just past the 180 ms animation. */
const SETTLE_MS = 240;

/**
 * Whether this node is the one an accepted continuation just created, so its view can play the
 * one-shot "settle" (ghost → real). Clears the marker itself a beat later — the same one-shot
 * shape as `jumpFlashId`.
 */
export function useSettle(id: string): boolean {
  const settling = useUiStore((state) => state.settleNodeId === id);
  useEffect(() => {
    if (!settling) return;
    const timeout = window.setTimeout(() => useUiStore.getState().setSettleNodeId(null), SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, [settling]);
  return settling;
}
