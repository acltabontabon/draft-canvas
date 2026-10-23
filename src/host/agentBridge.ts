/**
 * The editor's end of an agent's change to the open document (desktop only; see
 * `src/desktop/agent.ts` for the other end). Two questions, both answered synchronously against the
 * store so nothing can slip in between the check and the change:
 *
 * - **snapshot** — the whole file as it stands, its revision, and whether now is a bad moment (a drag,
 *   a field being typed in, a presentation on screen).
 * - **commit** — apply this new file as one undo step, *if* the revision is still the one the change
 *   was computed against. A manual edit made while the agent's layout was running bumps the revision,
 *   so the caller gets the current file to check for overlap and rebase instead of overwriting it.
 */

import type { DraftDocument } from '../document/types';
import type { Selection } from '../history/HistoryStack';
import { isEditableTarget } from '../lib/isEditableTarget';
import { typedWithin } from '../lib/recentTyping';
import { fileWithLiveViewport, isInteracting, useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useCollabStore } from '../store/collabStore';
import { collaboratorTouches } from '../store/collabBridge';

/** Changes once per page load, so a revision from before a reload or restart can never match. */
const EPOCH = Math.random().toString(36).slice(2, 8);

export type AgentEditorRequest =
  | { kind: 'snapshot' }
  | { kind: 'commit'; expectedRevision: string; file: DraftDocument; label: string };

export type AgentEditorReply =
  /** `path`: the room the person is looking at (element ids from the top), `[]` at the top.
   *  `selection`: what they currently have selected, in that same room — read_selection's source. */
  | { kind: 'snapshot'; file: DraftDocument; revision: string; path: string[]; selection: Selection; collaboratorTouches?: { key: string; by: string }[]; busy?: string }
  | { kind: 'committed'; revision: string }
  | { kind: 'refused'; code: 'REVISION_CONFLICT'; revision: string; file: DraftDocument }
  | { kind: 'refused'; code: 'BUSY'; revision: string; reason?: string };

export function currentRevision(): string {
  return `o:${EPOCH}.${useEditorStore.getState().revision}`;
}

/** How long after the last keystroke a focused field still counts as being typed in. Focus alone
 *  isn't enough: counted as busy, an idle title or inspector field held every agent change back
 *  until the person happened to click elsewhere. */
const TYPING_IDLE_MS = 2500;

/** Why an outside change must wait, if it must. Never steals focus to make the moment right. */
export function busyReason(): string | undefined {
  // A collaborator's copy is not the diagram: the owner's is, and an agent edit here would only be
  // a patch the owner might refuse. Agents work on the owner's machine.
  if (useCollabStore.getState().role === 'guest') return 'This diagram is open as a collaborator in someone else’s session; agents can edit it on the owner’s copy.';
  if (isInteracting()) return 'Someone is dragging or resizing on the canvas.';
  if (typeof document !== 'undefined' && isEditableTarget(document.activeElement) && typedWithin(TYPING_IDLE_MS)) {
    return 'Someone is typing in the diagram.';
  }
  if (useEditorStore.getState().mode === 'present') return 'The diagram is being presented.';
  // A change to the diagram cancels a trace in progress (see `editorStore`), losing the person's picks.
  if (useUiStore.getState().flowTrace) return 'Someone is tracing a flow on the diagram.';
  return undefined;
}

export function handleAgentRequest(request: AgentEditorRequest): AgentEditorReply {
  const state = useEditorStore.getState();
  if (request.kind === 'snapshot') {
    const busy = busyReason();
    const touches = collaboratorTouches();
    return {
      kind: 'snapshot',
      file: fileWithLiveViewport(state),
      revision: currentRevision(),
      path: [...state.path],
      selection: { nodes: [...state.selection.nodes], edges: [...state.selection.edges] },
      ...(touches.length ? { collaboratorTouches: touches } : {}),
      ...(busy ? { busy } : {}),
    };
  }
  const revision = currentRevision();
  if (request.expectedRevision !== revision) return { kind: 'refused', code: 'REVISION_CONFLICT', revision, file: fileWithLiveViewport(state) };
  const busy = busyReason();
  if (busy) return { kind: 'refused', code: 'BUSY', revision, reason: busy };
  const applied = state.applyToFile(request.label, () => request.file);
  if (applied) return { kind: 'committed', revision: currentRevision() };
  // Refused by the store's own last gates, which `busyReason` can miss in a race. Answered as
  // committed, the agent was told its change landed when nothing changed.
  if (isInteracting()) return { kind: 'refused', code: 'BUSY', revision, reason: 'Someone is dragging or resizing on the canvas.' };
  if (useUiStore.getState().readOnly) return { kind: 'refused', code: 'BUSY', revision, reason: 'The diagram is read-only.' };
  // Otherwise the file already was what was asked for: nothing to change, and nothing refused.
  return { kind: 'committed', revision };
}
