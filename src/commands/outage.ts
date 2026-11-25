/**
 * Starting and steering an outage walk. Every way in — the status bar chip, the palette, a shape's
 * menu — goes through here, so they agree on what a click means: with one shape selected that can
 * be taken down, it is; with one connector selected, that is; otherwise the walk opens and waits for
 * the next shape or connector chosen.
 *
 * A fix is the person answering a question the walk raised by drawing the answer. Each is one
 * existing store action, so it is an ordinary edit: one undo step, and the walk reads the diagram
 * again as soon as it lands.
 */

import { useEditorStore } from '../store/editorStore';
import { mayTakeDown, type OutageFix } from '../traffic';

type Editor = ReturnType<typeof useEditorStore.getState>;

/** The one selected shape, when it is something an outage can be read from. */
export function outageCandidate(editor: Pick<Editor, 'selection' | 'document'>): string | null {
  const { nodes, edges } = editor.selection;
  const only = nodes.length === 1 && edges.length === 0 ? nodes[0]! : null;
  return only && mayTakeDown(editor.document.nodes, only) ? only : null;
}

/** The one selected connector, when nothing else is selected with it. */
export function connectorCandidate(editor: Pick<Editor, 'selection'>): string | null {
  const { nodes, edges } = editor.selection;
  return nodes.length === 0 && edges.length === 1 ? edges[0]! : null;
}

export function startOutage(editor: Editor = useEditorStore.getState()): void {
  const candidate = outageCandidate(editor);
  const connector = candidate ? null : connectorCandidate(editor);
  if (candidate) editor.takeDown(candidate);
  else if (connector) editor.cutConnector(connector);
  else editor.startOutage();
}

export function toggleOutage(): void {
  const editor = useEditorStore.getState();
  if (editor.outage.active) editor.endOutage();
  else startOutage(editor);
}

/** What a fix is called on its button. */
export function outageFixLabel(fix: OutageFix): string {
  if (fix.kind === 'dead-letter') return 'Add a dead-letter queue';
  if (fix.kind === 'replay') return 'Draw the replay route';
  return 'Run two instances';
}

export function applyOutageFix(fix: OutageFix, editor: Editor = useEditorStore.getState()): void {
  if (fix.kind === 'dead-letter') editor.addDeadLetterQueue(fix.queue);
  else if (fix.kind === 'replay') editor.addReplayRoute(fix.from, fix.to);
  else editor.updateNodeById(fix.node, { replicas: 2 }, 'Run two instances');
}
