import { useShallow } from 'zustand/react/shallow';
import '../../styles/collab.css';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Tooltip } from '../common/Tooltip';
import { toolbarLabel, toolbarTooltip } from '../Editor/toolbar/toolbarTooltips';

/**
 * The toolbar's view of a live session: a quiet "people" button before one starts; while one runs,
 * the same people glyph lit by a breathing dot, with how many are here, a second dot when someone is
 * waiting to join, and a word only when the connection is in trouble. Either way it opens the
 * Collaborate dialog. Static and tiny — the dialog and everything that connects stay in their own
 * chunk until someone asks for them.
 */
export function CollabControl() {
  const open = useUiStore((state) => state.collabOpen);
  const setOpen = useUiStore((state) => state.setCollabOpen);
  const { role, status, peers, knocks } = useCollabStore(
    useShallow((state) => ({ role: state.role, status: state.status, peers: state.peers, knocks: state.knocks.length + state.lanKnocks.length })),
  );

  if (role === 'off') {
    return (
      <Tooltip content={toolbarTooltip('collaborate')}>
        {(tip) => (
          <Button icon="people" variant="quiet" active={open} aria-haspopup="dialog" onClick={() => setOpen(true)} aria-label={toolbarLabel('collaborate')} {...tip} />
        )}
      </Tooltip>
    );
  }

  const present = peers.filter((peer) => peer.link !== 'gone');
  const people = present.length + 1;
  const trouble = status === 'reconnecting' ? 'Reconnecting…' : status === 'ended' ? 'Ended' : status === 'joining' ? 'Joining…' : undefined;
  const waiting = role === 'host' ? knocks : 0;
  const label = `Live session, ${people} ${people === 1 ? 'person' : 'people'}${waiting ? `, ${waiting} waiting to join` : ''}${trouble ? ` — ${trouble.replace('…', '')}` : ''}`;

  // The people themselves are on the canvas (`PresenceDock`); the bar only says a session is live.
  return (
    <Button icon="people" variant="ghost" className="dc-collab-control" active={open} aria-haspopup="dialog" aria-label={label} data-status={status} onClick={() => setOpen(true)}>
      {/* The glyph lights up: a dot on the people icon says "live" without a word for it. */}
      <span className="dc-collab-live-dot" aria-hidden="true" />
      {trouble && <span className="dc-mode-label">{trouble}</span>}
      <span className="dc-collab-count" aria-hidden="true">
        {people}
      </span>
      {waiting > 0 && <span className="dc-collab-waiting-dot" aria-hidden="true" />}
    </Button>
  );
}
