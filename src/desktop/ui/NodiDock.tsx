import { useUiStore } from '../../store/uiStore';
import { useNodiDock } from '../nodiDock';
import { Mascot } from './mascot/Mascot';

/**
 * Nodi's bunk at the end of the status bar. While Nodi is out on the canvas it is an empty place the
 * jump starts from and ends in, the same size either way so the status bar never shifts; while Nodi
 * is down here, Nodi, small, blinking, one click from the conversation. Only while the companion is
 * on this canvas at all (`nodiDock.ts`).
 */
export function NodiDock() {
  const { present, docked, resting } = useNodiDock();
  if (!present) return null;
  return (
    <>
      <span className="dc-inspector-divider" />
      {docked ? (
        <button
          type="button"
          className="dc-nodi-dock"
          data-nodi-dock=""
          data-docked="true"
          aria-label="Open Nodi"
          title="Nodi: click to chat"
          onClick={() => useUiStore.getState().setCompanionOpen(true)}
        >
          <Mascot mood={resting} scale={1} />
        </button>
      ) : (
        <span className="dc-nodi-dock" data-nodi-dock="" aria-hidden="true" />
      )}
    </>
  );
}
