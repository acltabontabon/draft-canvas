import { hostKind } from '../../host/hostInfo';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';

/**
 * Whether the agent companion belongs on the canvas now: in the desktop app, for someone who may
 * edit — not a collaboration guest, not a read-only document — and not while presenting. Its agent
 * changes the owner's file, so a guest never gets one.
 */
export function companionAllowed(presenting: boolean): boolean {
  return hostKind() === 'desktop' && !presenting && useUiStore.getState().readOnly === null && useCollabStore.getState().role !== 'guest';
}
