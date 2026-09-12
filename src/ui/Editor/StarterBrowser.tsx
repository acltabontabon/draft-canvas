import { ARCHITECTURE_STARTERS, type StarterId } from '../../starters';
import { Modal } from '../common/Modal';
import { StarterShelf } from '../Library/StarterShelf';

/**
 * Every starter, on demand — the same shelf the home screen shows, so "browse all" doesn't hand
 * a drawing back as a list of names. The blank canvas offers four; this is where the other six
 * live, one click away and out of the way until asked for.
 */
export function StarterBrowser({
  onStart,
  onClose,
}: {
  onStart: (id: StarterId) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Starters" width={780} onClose={onClose} className="dc-modal-starters">
      <StarterShelf
        starters={ARCHITECTURE_STARTERS}
        onStart={(id) => {
          // Close first: the canvas behind is about to stop being empty, and a dialog left open
          // over a freshly drawn architecture hides the thing it just made.
          onClose();
          onStart(id);
        }}
      />
    </Modal>
  );
}
