import { useShallow } from 'zustand/react/shallow';
import '../../styles/collab.css';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import { PeerBadge } from './PeerBadge';

/** Faces shown before the rest fold into "+N": enough to recognise a small session at a glance. */
const FACES = 3;

/**
 * The toolbar's view of a live session: the people in it, as a pile of faces beside Share — yours
 * first, each in their own colour — with a breathing dot that says it is live, a dashed "?" face for
 * anyone waiting to be let in, and a word only when the connection is in trouble. It opens the
 * Collaborate dialog. Before a session there is nothing here; Share is how one starts. Static and
 * tiny — the dialog and everything that connects stay in their own chunk until someone asks.
 */
export function CollabControl() {
  const open = useUiStore((state) => state.collabOpen);
  const setOpen = useUiStore((state) => state.setCollabOpen);
  const { role, status, peers, knocks, selfName, selfColor } = useCollabStore(
    useShallow((state) => ({
      role: state.role,
      status: state.status,
      peers: state.peers,
      knocks: state.knocks.length + state.lanKnocks.length,
      selfName: state.selfName,
      selfColor: state.selfColor,
    })),
  );

  if (role === 'off') return null;

  const present = peers.filter((peer) => peer.link !== 'gone');
  const people = present.length + 1;
  const trouble = status === 'reconnecting' ? 'Reconnecting…' : status === 'ended' ? 'Ended' : status === 'joining' ? 'Joining…' : undefined;
  const waiting = role === 'host' ? knocks : 0;
  const label = `Live session, ${people} ${people === 1 ? 'person' : 'people'}${waiting ? `, ${waiting} waiting to join` : ''}${trouble ? ` — ${trouble.replace('…', '')}` : ''}`;
  const faces = [{ id: 'self', name: selfName, color: selfColor }, ...present.map((peer) => ({ id: peer.id, name: peer.name, color: peer.color }))];
  const shown = faces.slice(0, FACES);
  const more = faces.length - shown.length;

  return (
    <button type="button" className="dc-collab-control" data-active={open ? 'true' : undefined} aria-haspopup="dialog" aria-label={label} title={label} data-status={status} onClick={() => setOpen(true)}>
      <span className="dc-collab-stack" aria-hidden="true">
        {shown.map((face) => (
          <PeerBadge key={face.id} name={face.name} color={face.color} size="small" />
        ))}
        {more > 0 && <span className="dc-peer-badge dc-collab-more" data-size="small">+{more}</span>}
        {waiting > 0 && <span className="dc-peer-badge dc-collab-knocking" data-size="small">?</span>}
      </span>
      <span className="dc-collab-live-dot" aria-hidden="true" />
      {trouble && <span className="dc-mode-label">{trouble}</span>}
    </button>
  );
}
