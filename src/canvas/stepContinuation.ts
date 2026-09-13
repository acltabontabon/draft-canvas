import { continuationsFor, materialize } from '../continuation';
import { lensFlow, type EditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

/**
 * What `]` (`+1`) and `[` (`-1`) do on the canvas: step the showing suggestion to its next or
 * previous alternative, wrapping — or, when nothing is showing for the one selected node, ask for
 * suggestions explicitly (the best one for `]`, the last for `[`), the keyboard twin of dragging a
 * connector out. Returns whether the key was used, so the caller only swallows keys that did
 * something — nothing is asked for while the flow lens or a drag has continuation switched off, and
 * a candidate with no clear place to go is skipped.
 *
 * The caller owns focus and mode gating (canvas focus, presenting, playback, Focus); this owns
 * everything about continuation itself.
 */
export function stepContinuation(
  editor: Pick<EditorStore, 'document' | 'selection' | 'selectedFlowId' | 'flowPlayback' | 'focus'>,
  delta: 1 | -1,
): boolean {
  const ui = useUiStore.getState();
  if (!ui.continuationsEnabled || ui.quickConnect || ui.contextMenu || ui.openAttachmentDetail || ui.interactionActive) return false;
  if (lensFlow(editor)) return false;
  const { nodes, edges } = editor.selection;
  if (nodes.length !== 1 || edges.length > 0) return false;
  const anchorId = nodes[0]!;

  const offer = ui.continuation;
  if (offer?.trigger === 'drop') return false;
  if (offer && offer.anchorId === anchorId) {
    ui.cycleContinuation(delta);
    return true;
  }

  const candidates = continuationsFor(editor.document, anchorId, 'invoke', { recent: ui.continuationRecent });
  const pick = (delta === 1 ? candidates : candidates.toReversed()).find((c) => materialize(editor.document, c) !== undefined);
  if (!pick) return false;
  ui.setContinuationCycle({ anchorId, neighborhoodKey: pick.neighborhoodKey, candidateId: pick.id });
  return true;
}
