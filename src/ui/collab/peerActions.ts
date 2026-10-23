import { removeCollaborator, undoChangesOf } from '../../store/collabBridge';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';

/** Takes back one person's changes and says, in plain words, how that went. */
export function undoPersonChanges(peerId: string, name: string): void {
  const notify = useUiStore.getState().notify;
  switch (undoChangesOf(peerId, name)) {
    case 'done':
      return notify(`Took back ${name}’s changes. Undo brings them back.`);
    case 'partial':
      return notify(`Took back ${name}’s changes, except what others have changed or built on since.`);
    case 'blocked':
      return notify(`${name}’s changes stay: others have built on them.`, 'error');
    case 'nothing':
      return notify(`Nothing of ${name}’s is left to take back.`);
    case 'too-large':
      return notify(`Taking back ${name}’s changes would make this diagram too large.`, 'error');
    case 'busy':
      return notify(`Finish what you’re doing on the canvas, then take back ${name}’s changes.`);
    case 'ended':
      return notify(`The session has ended, so ${name}’s changes can’t be taken back on their own any more. Undo still steps back through your own edits.`);
  }
}

/**
 * Removes someone from the session. If they changed the canvas, the notice offers to take that back
 * too — the usual reason to remove an editor mid-session.
 */
export function removePerson(peerId: string, name: string): void {
  const authored = useCollabStore.getState().authors[peerId] !== undefined;
  removeCollaborator(peerId);
  const notify = useUiStore.getState().notify;
  if (authored) notify(`${name} was removed from the session.`, 'info', { label: 'Undo their changes', run: () => undoPersonChanges(peerId, name) });
}
