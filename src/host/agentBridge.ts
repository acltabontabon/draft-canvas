/**
 * The editor's end of an agent's change to the open document (desktop only; see
 * `src/desktop/agent.ts` for the other end). Two questions, both answered synchronously against the
 * store so nothing can slip in between the check and the change:
 *
 * - **snapshot** — the whole file as it stands, its revision, and whether now is a bad moment (a drag,
 *   a field being typed in, a presentation on screen).
 * - **commit** — apply this new file as one undo step, *if* the revision is still the one the change
 *   was computed against. A manual edit made while the agent's layout was running bumps the revision,
 *   so it turns into a conflict here instead of being overwritten.
 */

import type { DraftDocument } from '../document/types';
import { isEditableTarget } from '../lib/isEditableTarget';
import { fileWithLiveViewport, isInteracting, useEditorStore } from '../store/editorStore';

/** Changes once per page load, so a revision from before a reload or restart can never match. */
const EPOCH = Math.random().toString(36).slice(2, 8);

export type AgentEditorRequest =
  | { kind: 'snapshot' }
  | { kind: 'commit'; expectedRevision: string; file: DraftDocument; label: string };

export type AgentEditorReply =
  /** `path`: the room the person is looking at (element ids from the top), `[]` at the top. */
  | { kind: 'snapshot'; file: DraftDocument; revision: string; path: string[]; busy?: string }
  | { kind: 'committed'; revision: string }
  | { kind: 'refused'; code: 'REVISION_CONFLICT' | 'BUSY'; revision: string; reason?: string };

export function currentRevision(): string {
  return `o:${EPOCH}.${useEditorStore.getState().revision}`;
}

/** Why an outside change must wait, if it must. Never steals focus to make the moment right. */
export function busyReason(): string | undefined {
  if (isInteracting()) return 'Someone is dragging or resizing on the canvas.';
  if (typeof document !== 'undefined' && isEditableTarget(document.activeElement)) return 'Someone is typing in the diagram.';
  if (useEditorStore.getState().mode === 'present') return 'The diagram is being presented.';
  return undefined;
}

export function handleAgentRequest(request: AgentEditorRequest): AgentEditorReply {
  const state = useEditorStore.getState();
  if (request.kind === 'snapshot') {
    const busy = busyReason();
    return { kind: 'snapshot', file: fileWithLiveViewport(state), revision: currentRevision(), path: [...state.path], ...(busy ? { busy } : {}) };
  }
  const revision = currentRevision();
  if (request.expectedRevision !== revision) return { kind: 'refused', code: 'REVISION_CONFLICT', revision };
  const busy = busyReason();
  if (busy) return { kind: 'refused', code: 'BUSY', revision, reason: busy };
  const applied = state.applyToFile(request.label, () => request.file);
  return applied ? { kind: 'committed', revision: currentRevision() } : { kind: 'committed', revision };
}
