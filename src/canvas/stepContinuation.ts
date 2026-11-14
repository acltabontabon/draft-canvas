import { ANCHOR_TYPES, ambiguityOf, continuationsFor, materialize } from '../continuation';
import { lensFlow, spareRoom, viewLevel, type EditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

/**
 * `]` found nothing to suggest for this shape — the caller opens the add-element picker at it
 * instead, with `note` (why there is no suggestion, from `continuation/ambiguity.ts`) above it.
 */
export interface AskInstead {
  ask: string;
  note?: string;
}

/** What `]` says when the suggestion on screen has no alternative to step to. */
export const NO_OTHER_SUGGESTIONS = 'No other suggestions';

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
 * with the written-down reason there was no guess. Nor is it silence when there is a suggestion
 * and nothing else to step to ("No other suggestions", said through the pill and the live region),
 * or when what was found would not fit in the file (a toast saying so).
 *
 * The caller owns focus and mode gating (canvas focus, presenting, playback, Focus); this owns
 * everything about continuation itself.
 */
export function stepContinuation(
  editor: Pick<EditorStore, 'document' | 'selection' | 'selectedFlowId' | 'flowPlayback' | 'focus' | 'traffic' | 'path' | 'outer'>,
  delta: 1 | -1,
): boolean | AskInstead {
  const ui = useUiStore.getState();
  // The Pencil hides the ghost: a key that acts on a suggestion nobody can see would add an invisible shape.
  if (!ui.continuationsEnabled || ui.quickConnect || ui.contextMenu || ui.openAttachmentDetail || ui.interactionActive || ui.pencil) return false;
  if (lensFlow(editor) || editor.traffic.active) return false;
  const { nodes, edges } = editor.selection;
  if (nodes.length !== 1 || edges.length > 0) return false;
  const anchorId = nodes[0]!;

  const offer = ui.continuation;
  if (offer?.trigger === 'drop') return false;
  if (offer && offer.anchorId === anchorId) {
    // Said, not swallowed: a key that does nothing and says nothing reads as a key that is broken.
    if ((offer.alternatives?.length ?? 0) < 2) ui.noteContinuation(NO_OTHER_SUGGESTIONS);
    else ui.cycleContinuation(delta);
    return true;
  }

  const candidates = continuationsFor(editor.document, anchorId, 'invoke', {
    recent: ui.continuationRecent,
    level: viewLevel(editor),
  });
  // What has a place to go *and* fits the file: a ghost accepting would refuse is not offered.
  const spare = spareRoom();
  let crowdedOut = false;
  const pick = (delta === 1 ? candidates : candidates.toReversed()).find((c) => {
    const placed = materialize(editor.document, c);
    if (!placed) return false;
    if (placed.nodes.length <= spare.nodes && placed.edges.length <= spare.edges) return true;
    crowdedOut = true;
    return false;
  });
  if (!pick && crowdedOut) {
    // Why nothing appeared — the one case where asking has an answer that is not "no suggestion".
    ui.notify('No room for a suggestion — this diagram is already as large as it can be.', 'error');
    return true;
  }
  if (!pick) {
    const anchor = editor.document.nodes.find((node) => node.id === anchorId);
    if (!anchor || !ANCHOR_TYPES.has(anchor.type)) return false;
    // The reason is only true when there was nothing to suggest — not when a suggestion had no room.
    const note = candidates.length === 0 ? ambiguityOf(editor.document, anchorId, viewLevel(editor))?.reason : undefined;
    return { ask: anchorId, note };
  }
  ui.setContinuationCycle({ anchorId, neighborhoodKey: pick.neighborhoodKey, candidateId: pick.id });
  return true;
}
