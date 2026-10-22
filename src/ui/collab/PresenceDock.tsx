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
import { ROLE_LABELS } from './collabCopy';
import { PeerBadge } from './PeerBadge';

/**
 * The people in a live session, on the canvas they share rather than squeezed into the toolbar: a
 * column of faces at the canvas's edge. Each says at a glance what that person is doing — typing,
 * presenting, somewhere else in the diagram — and opens a card with where they are, a way to go
 * there, and (for the owner) what they may do. Someone at the door arrives here too, ringed and
 * breathing, with Let in and Deny on their card.
 */
export function PresenceDock() {
  const { role, peers, relayKnocks, lanKnocks, presence, presenter, status } = useCollabStore(
    useShallow((state) => ({
      role: state.role,
      peers: state.peers,
      relayKnocks: state.knocks,
      lanKnocks: state.lanKnocks,
      presence: state.presence,
      presenter: state.presenter,
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
        <DockPerson key={peer.id} peer={peer} presence={presence[peer.id]} owner={role === 'host'} presenting={peer.role === 'owner' && presenter !== null} />
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
  const taken = useCollabStore(useShallow((state) => [state.selfName, ...state.peers.filter((peer) => peer.link !== 'gone').map((peer) => peer.name)].map(nameKey)));
  return (
    <div className="dc-dock-door" role="region" aria-label="Waiting to join">
      <span className="dc-dock-door-title">{knocks.length === 1 ? 'Wants to join' : `${knocks.length} want to join`}</span>
      {knocks.map((knock) => (
        <DoorRow key={knock.id} knock={knock} lookalike={taken.includes(nameKey(knock.name))} />
      ))}
    </div>
  );
}

/** How two names compare for "is this the same person's name": case- and accent-blind. */
function nameKey(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

function DoorRow({ knock, lookalike }: { knock: KnockView; lookalike: boolean }) {
  const [role, setRole] = useState<Role>('editor');
  return (
    <div className="dc-dock-door-row" role="group" aria-label={`${knock.name} is asking to join`}>
      <span className="dc-dock-card-name">{knock.name}</span>
      {!knock.admitting && <span className="dc-dock-card-meta">Let them in to draw with you, or just to watch.</span>}
      {lookalike && (
        <span className="dc-dock-card-warning" role="note">
          Someone here already goes by this name — make sure it’s who you expect.
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

function DockPerson({ peer, presence, owner, presenting }: { peer: PeerView; presence: Presence | undefined; owner: boolean; presenting: boolean }) {
  const { setCenter } = useReactFlow();
  const myRoom = useEditorStore((state) => state.path[state.path.length - 1] ?? '');
  const elsewhere = presence !== undefined && presence.room !== myRoom;
  const typing = presence?.editing != null;
  const authored = useCollabStore((state) => state.authors[peer.id] === true);
  const where = !presence ? 'Away from the canvas' : elsewhere ? `Inside ${roomName(presence.room)}` : presence.pointer ? 'Here with you' : 'In this view';
  const glyph = presenting ? 'present' : typing ? 'pencil' : elsewhere ? 'down' : null;

  const find = () => {
    if (!presence) return;
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
    if (target) void setCenter(target.x, target.y, { duration: 420, zoom: Math.max(0.8, useEditorStore.getState().liveViewport?.zoom ?? 1) });
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
          {presence && (
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
