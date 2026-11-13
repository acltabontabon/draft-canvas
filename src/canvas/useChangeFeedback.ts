import { useEffect } from 'react';
import { samePath } from '../depth/tree';
import { prefersReducedMotion } from '../lib/motion';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { canvasChange, historyStep } from './changeFeedback';
import { playDepartures, playGlide, readPositions } from './changeMotion';

/**
 * The canvas shows what a change did, so nobody has to spot the difference themselves: a new shape
 * settles in where it was put, a new connector draws itself from source to target, a deleted one
 * fades where it stood, and an undo or redo glides moved shapes back and pulses what it changed in
 * place. The same for every way a change arrives — a tool, paste, a collaborator, an agent's commit.
 *
 * One store subscription for the whole canvas. It runs as the store changes, before React commits,
 * which is the last moment a departing element is still on the page. Nothing here writes to the
 * document or history: arrivals and pulses are a short-lived `uiStore` marker the views read, and
 * departures and glides are Web Animations on elements this canvas owns.
 */
export function useChangeFeedback(): void {
  useEffect(
    () =>
      useEditorStore.subscribe((state, prev) => {
        if (state.document === prev.document) return;
        // Another diagram, or another room of this one: everything on screen is replaced, which
        // is a new view, not a change to point at.
        if (state.document.metadata.id !== prev.document.metadata.id || !samePath(state.path, prev.path)) return;
        if (prefersReducedMotion()) return;
        const step = historyStep(prev.history, state.history);
        const change = canvasChange(prev.document, state.document, step);
        if (!change) return;

        if (change.departedNodes.length > 0 || change.departedEdges.length > 0) {
          playDepartures(change.departedNodes, change.departedEdges);
        }
        if (change.movedNodes.length > 0) {
          const moved = new Set(change.movedNodes);
          const touching = state.document.edges
            .filter((edge) => moved.has(edge.source) || moved.has(edge.target))
            .map((edge) => edge.id);
          void playGlide(readPositions(change.movedNodes), touching);
        }
        const arriving = [...change.arrivedNodes, ...change.arrivedEdges];
        const changed = [...change.changedNodes, ...change.changedEdges];
        if (arriving.length > 0 || changed.length > 0) useUiStore.getState().markCanvasChange(arriving, changed);
      }),
    [],
  );
}
