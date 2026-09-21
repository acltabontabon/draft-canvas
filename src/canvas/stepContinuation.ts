import { ANCHOR_TYPES, ambiguityOf, continuationsFor, materialize } from '../continuation';
import { lensFlow, viewLevel, type EditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

/**
 * `]` found nothing to suggest for this shape — the caller opens the add-element picker at it
 * instead, with `note` (why there is no suggestion, from `continuation/ambiguity.ts`) above it.
 */
export interface AskInstead {
  ask: string;
  note?: string;
}

/**
 * What `]` (`+1`) and `[` (`-1`) do on the canvas: step the showing suggestion to its next or
 * previous alternative, wrapping — or, when nothing is showing for the one selected node, ask for
 * suggestions explicitly (the best one for `]`, the last for `[`), the keyboard twin of dragging a
 * connector out. Returns whether the key was used, so the caller only swallows keys that did
 * something — nothing is asked for while the flow lens or a drag has continuation switched off, and
 * a candidate with no clear place to go is skipped.
 *
 * When asking finds nothing at all (or nothing with a place to go), the answer is not silence: an
 * `AskInstead` tells the caller to open the picker at the anchor — "what comes next?" asked back,
 * with the written-down reason there was no guess.
 *
 * The caller owns focus and mode gating (canvas focus, presenting, playback, Focus); this owns
 * everything about continuation itself.
 */
export function stepContinuation(
  editor: Pick<EditorStore, 'document' | 'selection' | 'selectedFlowId' | 'flowPlayback' | 'focus' | 'path' | 'outer'>,
  delta: 1 | -1,
): boolean | AskInstead {
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

  const candidates = continuationsFor(editor.document, anchorId, 'invoke', {
    recent: ui.continuationRecent,
    level: viewLevel(editor),
  });
  const pick = (delta === 1 ? candidates : candidates.toReversed()).find((c) => materialize(editor.document, c) !== undefined);
  if (!pick) {
    const anchor = editor.document.nodes.find((node) => node.id === anchorId);
    if (!anchor || !ANCHOR_TYPES.has(anchor.type)) return false;
    return { ask: anchorId, note: ambiguityOf(editor.document, anchorId, viewLevel(editor))?.reason };
  }
  ui.setContinuationCycle({ anchorId, neighborhoodKey: pick.neighborhoodKey, candidateId: pick.id });
  return true;
}
