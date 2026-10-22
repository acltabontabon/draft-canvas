import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { indexOf, pathOf } from '../../collab/fileIndex';
import type { PeerView, Presence, Role } from '../../collab/protocol';
import { answerKnock, setCollaboratorRole } from '../../store/collabBridge';
import { removePerson, undoPersonChanges } from './peerActions';
import { useCollabStore, type KnockView } from '../../store/collabStore';
import { fileOf, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { LOOKALIKE_WARNING, nameKey, RETURNING_NOTE, ROLE_LABELS, takenNameKeys } from './collabCopy';
import { PeerBadge } from './PeerBadge';

/**
 * The people in a live session, on the canvas they share rather than squeezed into the toolbar: a
 * column of faces at the canvas's edge. Each says at a glance what that person is doing — typing,
 * presenting, somewhere else in the diagram — and opens a card with where they are, a way to go
 * there, and (for the owner) what they may do. Someone at the door arrives here too, ringed and
 * breathing, with Let in and Deny on their card.
 */
export function PresenceDock() {
  // Not `presence`: pointers move twenty times a second per person, and each face reads the little
  // it shows for itself (`DockPerson`), so the column doesn't re-render with every one.
  const { role, peers, relayKnocks, lanKnocks, presenting: someonePresents, status } = useCollabStore(
    useShallow((state) => ({
      role: state.role,
      peers: state.peers,
      relayKnocks: state.knocks,
      lanKnocks: state.lanKnocks,
      presenting: state.presenter !== null,
      status: state.status,
    })),
  );
  // Everyone at the door, however they came — the session link or the local network link.
  const knocks = [...relayKnocks, ...lanKnocks];
  const presenting = useEditorStore((state) => state.mode === 'present');
  if (role === 'off' || presenting) return null;
  const here = peers.filter((peer) => peer.link !== 'gone');
  if (here.length === 0 && knocks.length === 0) return <EmptyDock />;
  return (
    <aside className="dc-dock" aria-label="People in this session" data-status={status}>
      {role === 'host' && knocks.length > 0 && <Door knocks={knocks} />}
      {role === 'host' && knocks.map((knock) => <KnockSeat key={knock.id} knock={knock} />)}
      {here.map((peer) => (
        <DockPerson key={peer.id} peer={peer} owner={role === 'host'} presenting={peer.role === 'owner' && someonePresents} />
      ))}
    </aside>
  );
}

/** Nobody else here yet: one quiet seat that opens the invite, so the dock teaches what it is for. */
function EmptyDock() {
  const role = useCollabStore((state) => state.role);
  if (role !== 'host') return null;
  return (
    <aside className="dc-dock dc-dock-empty" aria-label="People in this session">
      <button type="button" className="dc-dock-invite" onClick={() => useUiStore.getState().setCollabOpen(true)} aria-label="Invite someone">
        <Icon name="plus" />
      </button>
      <span className="dc-dock-tip" aria-hidden="true">
        Live — invite someone
      </span>
    </aside>
  );
}

/** A face at the door: ringed and waiting. Its question is asked on the door card beside the dock. */
function KnockSeat({ knock }: { knock: KnockView }) {
  return (
    <div className="dc-dock-item dc-dock-knock" data-admitting={knock.admitting ? 'true' : undefined} aria-hidden="true">
      <span className="dc-dock-face">
        <PeerBadge name={knock.name} color={7} />
        <span className="dc-dock-glyph dc-dock-glyph-knock">?</span>
      </span>
    </div>
  );
}

/**
 * Everyone waiting to come in, on one card beside the top of the dock — a row each, so two people
 * knocking at once never stack one question over the other's buttons.
 */
function Door({ knocks }: { knocks: readonly KnockView[] }) {
  // Names are whatever each person typed: a knock wearing the name of someone already here is said to.
  const taken = useCollabStore(useShallow(takenNameKeys));
  return (
    <div className="dc-dock-door" role="region" aria-label="Waiting to join">
      <span className="dc-dock-door-title">{knocks.length === 1 ? 'Wants to join' : `${knocks.length} want to join`}</span>
      {knocks.map((knock) => (
        <DoorRow key={knock.id} knock={knock} lookalike={taken.includes(nameKey(knock.name))} />
      ))}
    </div>
  );
}

function DoorRow({ knock, lookalike }: { knock: KnockView; lookalike: boolean }) {
  const [role, setRole] = useState<Role>(knock.returning ?? 'editor');
  return (
    <div className="dc-dock-door-row" role="group" aria-label={`${knock.name} is asking to join`}>
      <span className="dc-dock-card-name">{knock.name}</span>
      {!knock.admitting && <span className="dc-dock-card-meta">{knock.returning ? RETURNING_NOTE : 'Let them in to draw with you, or just to watch.'}</span>}
      {lookalike && (
        <span className="dc-dock-card-warning" role="note">
          {LOOKALIKE_WARNING}
        </span>
      )}
      {knock.admitting ? (
        <span className="dc-dock-card-meta" aria-live="polite">
          Connecting…
        </span>
      ) : (
        <span className="dc-dock-card-actions">
          <select className="dc-select" aria-label={`What ${knock.name} can do`} value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="editor">{ROLE_LABELS.editor}</option>
            <option value="viewer">{ROLE_LABELS.viewer}</option>
          </select>
          <Button variant="solid" onClick={() => answerKnock(knock.id, role)}>
            Let in
          </Button>
          <Button variant="quiet" onClick={() => answerKnock(knock.id, null)}>
            Deny
          </Button>
        </span>
      )}
    </div>
  );
}

function DockPerson({ peer, owner, presenting }: { peer: PeerView; owner: boolean; presenting: boolean }) {
  const { setCenter, getZoom } = useReactFlow();
  const myRoom = useEditorStore((state) => state.path[state.path.length - 1] ?? '');
  // What the face shows, not where the pointer is: this changes when they arrive, leave, change rooms
  // or start typing — not with every move.
  const seen = useCollabStore(
    useShallow((state) => {
      const presence = state.presence[peer.id];
      return { here: presence !== undefined, room: presence?.room ?? '', typing: presence?.editing != null, pointer: presence?.pointer != null };
    }),
  );
  const elsewhere = seen.here && seen.room !== myRoom;
  const typing = seen.typing;
  const authored = useCollabStore((state) => state.authors[peer.id] !== undefined);
  const where = !seen.here ? 'Away from the canvas' : elsewhere ? `Inside ${roomName(seen.room)}` : seen.pointer ? 'Here with you' : 'In this view';
  const glyph = presenting ? 'present' : typing ? 'pencil' : elsewhere ? 'down' : null;

  const find = () => {
    // Where they are now, read at the click.
    const presence: Presence | undefined = useCollabStore.getState().presence[peer.id];
    if (!presence) return;
    const elsewhere = presence.room !== (useEditorStore.getState().path.at(-1) ?? '');
    const editor = useEditorStore.getState();
    if (elsewhere) {
      const path = pathOf(indexOf(fileOf(editor)), presence.room);
      if (!path) return;
      let shared = 0;
      while (shared < editor.path.length && shared < path.length && editor.path[shared] === path[shared]) shared += 1;
      if (shared < editor.path.length) editor.exitTo(shared);
      for (const id of path.slice(shared)) if (!useEditorStore.getState().enterInside(id)) return;
    }
    // Their pointer, or failing that what they have selected, framed with a soft glide.
    const target = presence.pointer ?? centreOf(presence.selection.nodes);
    if (!target) return;
    const glide = () => void setCenter(target.x, target.y, { duration: 420, zoom: Math.max(0.8, getZoom()) });
    // A room just entered moves the camera to that room's own view from an effect on `path`
    // (`Canvas`), which would cut this glide short: a frame later, it has run.
    if (elsewhere) requestAnimationFrame(glide);
    else glide();
  };

  return (
    <div className="dc-dock-item" data-link={peer.link}>
      <button type="button" className="dc-dock-face" aria-label={`${peer.name}: ${where}`} onClick={find}>
        <PeerBadge name={peer.name} color={peer.color} link={peer.link} />
        {glyph && (
          <span className="dc-dock-glyph" data-peer-color={peer.color % 8} aria-hidden="true">
            <Icon name={glyph} size={10} />
          </span>
        )}
      </button>
      <div className="dc-dock-card" role="group" aria-label={peer.name}>
        <span className="dc-dock-card-name">{peer.name}</span>
        <span className="dc-dock-card-meta">
          {peer.role === 'owner' ? 'Owner' : ROLE_LABELS[peer.role]} · {peer.link === 'reconnecting' ? 'Reconnecting…' : presenting ? 'Presenting' : typing ? 'Typing…' : where}
        </span>
        <span className="dc-dock-card-actions">
          {seen.here && (
            <Button variant="ghost" icon="pointer" onClick={find}>
              Find
            </Button>
          )}
          {owner && peer.role !== 'owner' && (
            <>
              <select className="dc-select" aria-label={`What ${peer.name} can do`} value={peer.role} onChange={(event) => setCollaboratorRole(peer.id, event.target.value as Role)}>
                <option value="editor">{ROLE_LABELS.editor}</option>
                <option value="viewer">{ROLE_LABELS.viewer}</option>
              </select>
              {authored && (
                <Button variant="quiet" icon="undo" aria-label={`Undo ${peer.name}’s changes`} title={`Undo ${peer.name}’s changes`} onClick={() => undoPersonChanges(peer.id, peer.name)} />
              )}
              <Button variant="quiet" icon="close" aria-label={`Remove ${peer.name} from the session`} onClick={() => removePerson(peer.id, peer.name)} />
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** The name of the shape whose inside a room is, for "Inside Payments API". */
function roomName(room: string): string {
  const node = indexOf(fileOf(useEditorStore.getState())).nodes.get(room)?.value;
  return node?.text?.trim() || 'another shape';
}

function centreOf(ids: readonly string[]): { x: number; y: number } | null {
  const nodes = useEditorStore.getState().document.nodes.filter((node) => ids.includes(node.id));
  if (nodes.length === 0) return null;
  const x = nodes.reduce((sum, node) => sum + node.x + node.width / 2, 0) / nodes.length;
  const y = nodes.reduce((sum, node) => sum + node.y + node.height / 2, 0) / nodes.length;
  return { x, y };
}
