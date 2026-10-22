import { lazy, Suspense, useId, useRef, useState } from 'react';
import { DEFAULT_STUN, peerConnectionsAvailable } from '../../collab/connect';
import { MAX_COLLABORATORS, readName, type PeerView, type Role } from '../../collab/protocol';
import { leaveSessionKeepingView, setCollaboratorRole, startHosting, stopHosting } from '../../store/collabBridge';
import { removePerson, undoPersonChanges } from './peerActions';
import { useShallow } from 'zustand/react/shallow';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Icon, type IconName } from '../common/Icon';
import { Modal } from '../common/Modal';
import { canShareLink, copyText, looksLikeCode, pasteText, shareLink } from './clipboard';
import { END_MESSAGES, LINK_LABELS, LOOKALIKE_WARNING, nameKey, readConnectionPreferences, readDisplayName, ROLE_LABELS, takenNameKeys, writeConnectionPreferences, writeDisplayName } from './collabCopy';
import { useInviteStore } from './inviteStore';
import { openLobby } from './lobbyStore';
import { answerKnock } from '../../store/collabBridge';
import { hostKind } from '../../host/hostInfo';
import { PeerBadge } from './PeerBadge';
import { NameTag } from './NameTag';
import { SessionScene, type ScenePerson } from './SessionScene';

function onDesktop(): boolean {
  return __DESKTOP__ && hostKind() === 'desktop';
}

// Desktop owners can also share over the local network; the panel loads only there.
const LanShare = __DESKTOP__ ? lazy(() => import('./LanShare').then((module) => ({ default: module.LanShare }))) : null;

/**
 * Collaborate — a live session in one dialog. The owner starts it, shares one link and lets people
 * in; a collaborator sees who is here and can leave. Everything a person needs is on the page:
 * nothing is folded away, and every choice is said in plain words, not network terms.
 */
export function CollaborateDialog() {
  const close = () => useUiStore.getState().setCollabOpen(false);
  const role = useCollabStore((state) => state.role);
  return (
    <Modal title={role === 'guest' ? 'Live session' : 'Collaborate'} onClose={close} width={540} className="dc-collab-dialog">
      {role === 'host' ? <Hosting onClose={close} /> : role === 'guest' ? <Joined onClose={close} /> : <Start />}
    </Modal>
  );
}

function Start() {
  const [name, setName] = useState(readDisplayName);
  const [network, setNetwork] = useState(() => readConnectionPreferences());
  const [ownServer, setOwnServer] = useState(() => network.server.trim() !== '');
  const serverId = useId();
  // The desktop app can always host: its local network link needs no peer connections.
  const available = peerConnectionsAvailable() || onDesktop();

  const start = () => {
    // As every collaborator will read it: the greeting is signed over this exact name, and one they
    // read differently (doubled spaces, an invisible character, past the length limit) never verifies.
    const trimmed = readName(name);
    if (!trimmed) return;
    writeDisplayName(trimmed);
    writeConnectionPreferences(ownServer ? network : { ...network, server: '' });
    startHosting({ name: trimmed });
    // The waiting room opens with the session: one link, and people knock to come in — through the
    // relay, so only when the owner chose "Anyone with the link". On "Only my network" nothing
    // outside the network is contacted: people come in by direct invite, or the desktop's local link.
    if (network.localOnly) useCollabStore.setState({ rendezvous: 'local' });
    else openLobby(trimmed);
  };

  const privacy = network.localOnly ? (
    <span>Nothing leaves your network — no relay, no STUN server. Your diagram goes straight from your browser to theirs, encrypted.</span>
  ) : (
    <>
      <span>
        Your diagram goes straight from your browser to theirs, encrypted. Draft Canvas never sees it. A relay passes along
        requests to join and a STUN server helps browsers find each other — they see IP addresses, never the diagram.
      </span>
      {ownServer ? (
        <label className="dc-collab-field" htmlFor={serverId}>
          <span>Server</span>
          <input
            id={serverId}
            value={network.server}
            maxLength={64}
            spellCheck={false}
            autoFocus
            placeholder={DEFAULT_STUN}
            onChange={(event) => setNetwork({ ...network, server: event.target.value })}
          />
        </label>
      ) : (
        <button type="button" className="dc-collab-textbutton" onClick={() => setOwnServer(true)}>
          Use your own STUN server
        </button>
      )}
    </>
  );

  return (
    <div className="dc-collab dc-collab-centred">
      <SessionScene owner={{ name: name.trim(), color: 0, you: true }} people={[]} privacy={privacy} />
      {/* How it works, as a little timeline in the scene's own dashed line — no heading needed. */}
      <ol className="dc-collab-how" aria-label="How it works">
        <li>
          <span aria-hidden="true">1</span>Share one link
        </li>
        <li>
          <span aria-hidden="true">2</span>They ask to join
        </li>
        <li>
          <span aria-hidden="true">3</span>You let them in
        </li>
      </ol>
      {!available && (
        <p className="dc-collab-error" role="alert">
          This browser can’t make direct connections, so it can’t host a session. Try a current Chrome, Edge, Firefox or
          Safari.
        </p>
      )}
      <form
        className="dc-collab-form"
        onSubmit={(event) => {
          event.preventDefault();
          start();
        }}
      >
        <NameTag value={name} onChange={setName} />
        <fieldset className="dc-collab-choice">
          <legend>Who can join?</legend>
          <Choice
            name="collab-network"
            checked={!network.localOnly}
            icon="globe"
            title="Anyone with the link"
            detail="Any home or office. You decide who gets in."
            onSelect={() => setNetwork({ ...network, localOnly: false })}
          />
          <Choice
            name="collab-network"
            checked={network.localOnly}
            icon="lock"
            title="Only my network"
            detail="Same Wi‑Fi only. You invite people one by one."
            onSelect={() => setNetwork({ ...network, localOnly: true })}
          />
        </fieldset>
        <Button type="submit" variant="solid" icon="people" className="dc-collab-go" disabled={!available || !readName(name)}>
          Start session
        </Button>
      </form>
    </div>
  );
}

/** One of a few big, plain choices: a radio button the size of its explanation. */
function Choice({ name, checked, icon, title, detail, onSelect }: { name: string; checked: boolean; icon: IconName; title: string; detail: string; onSelect: () => void }) {
  return (
    <label className="dc-collab-option" data-checked={checked ? 'true' : undefined}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} />
      <Icon name={icon} />
      <span className="dc-collab-option-text">
        <span className="dc-collab-option-title">{title}</span>
        <span className="dc-collab-option-detail">{detail}</span>
      </span>
    </label>
  );
}

/** Everyone the owner's scene shows: the people in the session, then whoever is at the door. */
function useHostScene(): ScenePerson[] {
  const { peers, knocks, lanKnocks } = useCollabStore(useShallow((state) => ({ peers: state.peers, knocks: state.knocks, lanKnocks: state.lanKnocks })));
  return [
    ...peers
      .filter((peer) => peer.link !== 'gone')
      .map((peer): ScenePerson => ({ key: peer.id, name: peer.name, color: peer.color, state: peer.link === 'live' ? 'live' : 'reconnecting' })),
    ...[...knocks, ...lanKnocks].map((knock): ScenePerson => ({ key: knock.id, name: knock.name, color: 7, state: knock.admitting ? 'joining' : 'knocking' })),
  ];
}

function Hosting({ onClose }: { onClose: () => void }) {
  const peers = useCollabStore((state) => state.peers);
  const authors = useCollabStore((state) => state.authors);
  // People who changed the canvas and have gone: their changes can still be taken back.
  const departed = Object.entries(authors).filter(([id]) => !peers.some((peer) => peer.id === id));
  const selfName = useCollabStore((state) => state.selfName);
  const scene = useHostScene();
  const present = peers.filter((peer) => peer.link !== 'gone');
  const full = present.length >= MAX_COLLABORATORS;
  return (
    <div className="dc-collab">
      <SessionScene
        owner={{ name: selfName, color: 0, you: true }}
        people={scene}
        privacy={
          <span>
            The link only introduces your browsers. Your diagram never passes through the relay — it goes straight between
            browsers, encrypted — and none of it is stored.
          </span>
        }
      />
      <Knocks />
      <InviteCard full={full} />
      <section className="dc-collab-section" aria-labelledby="dc-collab-people">
        <h3 id="dc-collab-people" className="dc-collab-heading">
          In this session <span className="dc-collab-count">{present.length + 1}</span>
        </h3>
        {/* The table from the scene, as a list: one dashed thread through everyone, ending in an empty seat. */}
        <div className="dc-collab-table">
          <ul className="dc-collab-people">
            <li className="dc-collab-person">
              <PeerBadge name={selfName} color={0} />
              <span className="dc-collab-person-name">{selfName}</span>
              <span className="dc-collab-pill">
                <Icon name="pencil" size={11} />
                You · owner
              </span>
            </li>
            {peers.map((peer) => (
              <Person key={peer.id} peer={peer} />
            ))}
            {departed.map(([id, name]) => (
              <li key={id} className="dc-collab-person" data-link="gone">
                <PeerBadge name={name} color={7} link="gone" />
                <span className="dc-collab-person-name">{name}</span>
                <span className="dc-collab-person-meta">Left</span>
                <span className="dc-collab-person-controls">
                  <Button variant="quiet" icon="undo" title={`Takes back everything ${name} changed this session, unless someone has changed or built on it since. Undo brings it back.`} onClick={() => undoPersonChanges(id, name)}>
                    Undo changes
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          {!full && <EmptySeat first={present.length === 0} room={MAX_COLLABORATORS - present.length} />}
        </div>
      </section>
      {LanShare && (
        <Suspense fallback={null}>
          <LanShare />
        </Suspense>
      )}
      <div className="dc-collab-footer">
        <Button
          variant="danger"
          onClick={() => {
            useInviteStore.getState().cancel();
            stopHosting('ended');
            useUiStore.getState().notify('Session ended. The canvas is just yours again.');
          }}
        >
          End session
        </Button>
        <Button variant="solid" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** The next free seat at the table: where someone you let in will sit, breathing like the scene's. */
function EmptySeat({ first, room }: { first: boolean; room: number }) {
  return (
    <div className="dc-collab-seat">
      <span className="dc-collab-seat-ring" aria-hidden="true" />
      <span className="dc-collab-seat-text">
        <span className="dc-collab-seat-title">{first ? 'Seats fill as you let people in' : `Room for ${room} more`}</span>
        {first && <span className="dc-collab-seat-meta">You can change what each person can do at any time.</span>}
      </span>
    </div>
  );
}

/**
 * How people get in: the one session link everyone shares — or, without the relay (the owner chose
 * their network only, or it can't be reached), or when the owner asks, a direct invite for one
 * person. A switch of what the card shows, never a fold to find.
 */
function InviteCard({ full }: { full: boolean }) {
  const rendezvous = useCollabStore((state) => state.rendezvous);
  // An invite already under way keeps the card on it.
  const [direct, setDirect] = useState(() => useInviteStore.getState().stage.kind !== 'idle');
  const linkPossible = rendezvous === 'connecting' || rendezvous === 'open';
  if (rendezvous === 'off') return null;
  if (direct || !linkPossible) {
    return (
      <section className="dc-collab-card" aria-labelledby="dc-collab-invite">
        <h3 id="dc-collab-invite" className="dc-collab-card-title">
          Invite one person
        </h3>
        <p className="dc-collab-hint" role={rendezvous === 'unavailable' ? 'status' : undefined}>
          {rendezvous === 'local'
            ? 'You chose your network only, so there’s no link to share: invite people one at a time. You send a link, they send back a code.'
            : rendezvous === 'unavailable'
              ? 'The session link can’t be made right now (the relay can’t be reached). Invite people one at a time instead: you send a link, they send back a code.'
              : 'No relay involved: you send one person a link, and they send you back a code to paste here.'}
        </p>
        <Invite full={full} />
        {linkPossible && (
          <button type="button" className="dc-collab-textbutton" onClick={() => setDirect(false)}>
            Back to the session link
          </button>
        )}
      </section>
    );
  }
  return (
    <section className="dc-collab-card" aria-labelledby="dc-collab-invite">
      <h3 id="dc-collab-invite" className="dc-collab-card-title">
        Invite people
      </h3>
      <SessionLink full={full} />
      <button type="button" className="dc-collab-textbutton" onClick={() => setDirect(true)}>
        Link not working for someone? Invite one person directly
      </button>
    </section>
  );
}

/**
 * The one link everyone joins by. Said plainly where it is copied, because "a relay" invites the
 * question: the relay introduces browsers, and the diagram never passes through it.
 */
function SessionLink({ full }: { full: boolean }) {
  const link = useCollabStore((state) => state.sessionLink);
  const [copied, setCopied] = useState(false);
  const notify = useUiStore((state) => state.notify);
  if (!link) {
    return (
      <p className="dc-collab-hint dc-collab-waiting" aria-live="polite">
        Making your link…
      </p>
    );
  }
  return (
    <>
      <div className="dc-collab-copy-row dc-collab-ticket">
        <input aria-label="Session link" className="dc-collab-code" value={link} readOnly onFocus={(event) => event.currentTarget.select()} />
        <Button
          icon={copied ? 'check' : 'copy'}
          variant={copied ? 'ghost' : 'solid'}
          disabled={full}
          onClick={async () => {
            if (await copyText(link)) setCopied(true);
            else notify('Couldn’t copy — select the link and copy it yourself.', 'error');
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        {canShareLink(link) && <Button icon="external" variant="quiet" aria-label="Share the session link" onClick={() => void shareLink(link, 'Join my Draft Canvas session')} />}
      </div>
      <p className="dc-collab-hint">
        {full
          ? `The session is full: it holds up to ${MAX_COLLABORATORS} collaborators.`
          : 'Send it to anyone you like. When they open it, they ask to join and you choose: let them in, or not.'}
      </p>
    </>
  );
}

function Knocks() {
  const relayKnocks = useCollabStore((state) => state.knocks);
  const lanKnocks = useCollabStore((state) => state.lanKnocks);
  const knocks = [...relayKnocks, ...lanKnocks];
  if (knocks.length === 0) return null;
  return (
    <section className="dc-collab-card dc-collab-door" aria-labelledby="dc-collab-knocks">
      <h3 id="dc-collab-knocks" className="dc-collab-card-title">
        Waiting to join <span className="dc-collab-count">{knocks.length}</span>
      </h3>
      <ul className="dc-collab-people">
        {knocks.map((knock) => (
          <KnockRow key={knock.id} id={knock.id} name={knock.name} admitting={knock.admitting} />
        ))}
      </ul>
    </section>
  );
}

export function KnockRow({ id, name, admitting }: { id: string; name: string; admitting?: Role }) {
  const [role, setRole] = useState<Role>('editor');
  // As the dock says it: a knock wearing the name of someone already here.
  const lookalike = useCollabStore(useShallow(takenNameKeys)).includes(nameKey(name));
  return (
    <li className="dc-collab-person dc-collab-knock" data-admitting={admitting ? 'true' : undefined}>
      <span className="dc-knock-seat" aria-hidden="true">
        <PeerBadge name={name} color={7} />
      </span>
      <span className="dc-collab-person-name">{name}</span>
      {lookalike && (
        <span className="dc-collab-person-meta dc-collab-lookalike" role="note">
          {LOOKALIKE_WARNING}
        </span>
      )}
      {admitting ? (
        <span className="dc-collab-person-meta" aria-live="polite">
          Connecting…
        </span>
      ) : (
        <span className="dc-collab-person-controls">
          <select className="dc-select" aria-label={`What ${name} can do`} value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="editor">{ROLE_LABELS.editor}</option>
            <option value="viewer">{ROLE_LABELS.viewer}</option>
          </select>
          <Button variant="solid" onClick={() => answerKnock(id, role)}>
            Let in
          </Button>
          <Button variant="quiet" onClick={() => answerKnock(id, null)} aria-label={`Don’t let ${name} in`}>
            Deny
          </Button>
        </span>
      )}
    </li>
  );
}

function Person({ peer }: { peer: PeerView }) {
  const create = useInviteStore((state) => state.create);
  const authored = useCollabStore((state) => state.authors[peer.id] !== undefined);
  const gone = peer.link === 'gone';
  const role: Role = peer.role === 'owner' ? 'editor' : peer.role;
  return (
    <li className="dc-collab-person" data-link={peer.link}>
      <PeerBadge name={peer.name} color={peer.color} link={peer.link} />
      <span className="dc-collab-person-name">{peer.name}</span>
      {peer.link !== 'live' && (
        <span className="dc-collab-person-meta" data-link={peer.link}>
          {LINK_LABELS[peer.link]}
        </span>
      )}
      <span className="dc-collab-person-controls">
        {gone ? (
          <Button variant="quiet" icon="refresh" onClick={() => void create(role, peer.id)}>
            Re-invite
          </Button>
        ) : (
          <select className="dc-select" aria-label={`What ${peer.name} can do`} value={role} onChange={(event) => setCollaboratorRole(peer.id, event.target.value as Role)}>
            <option value="editor">{ROLE_LABELS.editor}</option>
            <option value="viewer">{ROLE_LABELS.viewer}</option>
          </select>
        )}
        {authored && (
          <Button variant="quiet" icon="undo" title={`Takes back everything ${peer.name} changed this session, unless someone has changed or built on it since. Undo brings it back.`} onClick={() => undoPersonChanges(peer.id, peer.name)}>
            Undo changes
          </Button>
        )}
        <Button variant="quiet" icon="close" aria-label={`Remove ${peer.name} from the session`} onClick={() => removePerson(peer.id, peer.name)} />
      </span>
    </li>
  );
}

function Invite({ full }: { full: boolean }) {
  if (!peerConnectionsAvailable()) {
    return <p className="dc-collab-hint">Direct invites need direct connections, which aren’t available here. Share on your local network below instead.</p>;
  }
  return <InviteFlow full={full} />;
}

function InviteFlow({ full }: { full: boolean }) {
  const stage = useInviteStore((state) => state.stage);
  const { create, accept, cancel } = useInviteStore.getState();
  const [role, setRole] = useState<Role>('editor');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const codeId = useId();
  const linkId = useId();
  const notify = useUiStore((state) => state.notify);

  const link = stage.kind === 'ready' || stage.kind === 'connecting' ? stage.link : null;
  // A fresh invite starts with an empty reply box and its link not yet copied — adjusted while
  // rendering, as React recommends, rather than an effect that paints the stale state first.
  const [forLink, setForLink] = useState(link);
  if (link !== forLink) {
    setForLink(link);
    setCode('');
    setCopied(false);
  }

  const connect = (text: string) => {
    const cleaned = text.replace(/\s+/g, '');
    setCode(cleaned);
    if (cleaned) void accept(cleaned);
  };

  const copyLink = async (text: string) => {
    if (await copyText(text)) {
      setCopied(true);
      // Next, the reply: put the cursor where it goes.
      codeInput.current?.focus();
    } else notify('Couldn’t copy — select the link and copy it yourself.', 'error');
  };

  const pasteCode = async () => {
    const text = await pasteText();
    if (text === null) {
      notify('Couldn’t read the clipboard here — paste the code into the box instead.', 'error');
      codeInput.current?.focus();
    } else connect(text);
  };

  if (stage.kind === 'idle' || stage.kind === 'preparing') {
    return (
      <>
        <div className="dc-collab-invite-start">
          <select className="dc-select" aria-label="What they can do" value={role} onChange={(event) => setRole(event.target.value as Role)} disabled={full}>
            <option value="editor">{ROLE_LABELS.editor}</option>
            <option value="viewer">{ROLE_LABELS.viewer}</option>
          </select>
          <Button variant="solid" icon="plus" onClick={() => void create(role)} disabled={full || stage.kind === 'preparing'} aria-busy={stage.kind === 'preparing'}>
            {stage.kind === 'preparing' ? 'Preparing a connection…' : 'Create invite link'}
          </Button>
        </div>
        {full && <p className="dc-collab-hint">A session holds up to {MAX_COLLABORATORS} collaborators.</p>}
      </>
    );
  }

  const spent = stage.kind === 'ready' && stage.spent;
  const connecting = stage.kind === 'connecting';
  return (
    <>
      <ol className="dc-collab-steps">
        <li className="dc-collab-step" data-done={copied ? 'true' : undefined}>
          <label className="dc-collab-step-label" htmlFor={linkId}>
            Send this link to one person
          </label>
          <div className="dc-collab-copy-row">
            <input id={linkId} className="dc-collab-code" value={stage.link} readOnly onFocus={(event) => event.currentTarget.select()} />
            <Button icon={copied ? 'check' : 'copy'} variant={copied ? 'ghost' : 'solid'} onClick={() => void copyLink(stage.link)}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            {canShareLink(stage.link) && (
              <Button icon="external" variant="quiet" aria-label="Share the invite link" onClick={() => void shareLink(stage.link, 'Join my Draft Canvas session')} />
            )}
          </div>
          <p className="dc-collab-hint">
            {stage.role === 'editor' ? 'They’ll be able to edit.' : 'They’ll be able to view, not edit.'} It works once{stage.reuse ? ', to bring that person back,' : ''} until{' '}
            {new Date(stage.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
          </p>
        </li>
        <li className="dc-collab-step">
          <label className="dc-collab-step-label" htmlFor={codeId}>
            Paste their reply code
          </label>
          <form
            className="dc-collab-copy-row"
            onSubmit={(event) => {
              event.preventDefault();
              connect(code);
            }}
          >
            <input
              ref={codeInput}
              id={codeId}
              className="dc-collab-code"
              value={code}
              spellCheck={false}
              autoComplete="off"
              placeholder="They get it when they open your link"
              disabled={connecting || spent}
              aria-invalid={stage.kind === 'ready' && stage.error ? true : undefined}
              aria-describedby={stage.kind === 'ready' && stage.error ? `${codeId}-error` : undefined}
              onChange={(event) => setCode(event.target.value)}
              onPaste={(event) => {
                // Pasting a whole code is the moment to connect — no extra click.
                const text = event.clipboardData.getData('text');
                if (looksLikeCode(text)) {
                  event.preventDefault();
                  connect(text);
                }
              }}
            />
            {code.trim() || connecting ? (
              <Button type="submit" variant="solid" disabled={connecting || spent} aria-busy={connecting}>
                {connecting ? 'Connecting…' : 'Connect'}
              </Button>
            ) : (
              <Button icon="file" disabled={spent} onClick={() => void pasteCode()}>
                Paste
              </Button>
            )}
          </form>
          {stage.kind === 'ready' && stage.error && (
            <p id={`${codeId}-error`} className="dc-collab-error" role="alert">
              {stage.error}
            </p>
          )}
        </li>
      </ol>
      <div className="dc-collab-step-actions">
        {spent ? (
          <Button icon="refresh" onClick={() => void create(stage.role, stage.reuse)}>
            Create a new invite
          </Button>
        ) : (
          <Button variant="quiet" onClick={cancel}>
            Cancel invite
          </Button>
        )}
      </div>
    </>
  );
}

function Joined({ onClose }: { onClose: () => void }) {
  const peers = useCollabStore((state) => state.peers);
  const { selfName, selfColor, access, status, endReason } = useCollabStore(
    useShallow((state) => ({ selfName: state.selfName, selfColor: state.selfColor, access: state.access, status: state.status, endReason: state.endReason })),
  );
  const present = peers.filter((peer) => peer.link !== 'gone');
  const owner = present.find((peer) => peer.role === 'owner');
  const others = present.filter((peer) => peer.role !== 'owner');
  const scene: ScenePerson[] = [
    { key: 'self', name: selfName, color: selfColor, state: status === 'reconnecting' ? 'reconnecting' : 'live', you: true },
    ...others.map((peer): ScenePerson => ({ key: peer.id, name: peer.name, color: peer.color, state: peer.link === 'live' ? 'live' : 'reconnecting' })),
  ];
  return (
    <div className="dc-collab">
      {status !== 'ended' && (
        <SessionScene
          owner={{ name: owner?.name ?? 'Owner', color: owner?.color ?? 0 }}
          people={scene}
          privacy={<span>You’re connected straight to the owner’s browser, encrypted. The diagram never passes through Draft Canvas.</span>}
        />
      )}
      {status === 'ended' && endReason ? (
        <p className="dc-collab-error" role="status">
          {END_MESSAGES[endReason]} What you see stays on screen; make an editable copy to keep it.
        </p>
      ) : status === 'reconnecting' ? (
        <p className="dc-collab-hint" role="status">
          Reconnecting to the owner… Your edits wait and are sent once you’re back. If this doesn’t recover, ask them to
          re-invite you.
        </p>
      ) : (
        <p className="dc-collab-lead">
          You’re {access === 'editor' ? 'editing' : 'viewing'} {owner ? `${owner.name}’s` : 'the owner’s'} canvas live. Their copy is the one
          that’s saved.
        </p>
      )}
      <section className="dc-collab-section" aria-labelledby="dc-collab-people">
        <h3 id="dc-collab-people" className="dc-collab-heading">
          In this session <span className="dc-collab-count">{present.length + 1}</span>
        </h3>
        <ul className="dc-collab-people">
          {present.map((peer) => (
            <li key={peer.id} className="dc-collab-person">
              <PeerBadge name={peer.name} color={peer.color} />
              <span className="dc-collab-person-name">{peer.name}</span>
              <span className="dc-collab-person-meta">{peer.role === 'owner' ? 'Owner' : ROLE_LABELS[peer.role]}</span>
            </li>
          ))}
          <li className="dc-collab-person">
            <PeerBadge name={selfName} color={selfColor} />
            <span className="dc-collab-person-name">{selfName}</span>
            <span className="dc-collab-person-meta">You · {ROLE_LABELS[access === 'owner' ? 'editor' : access].toLowerCase()}</span>
          </li>
        </ul>
      </section>
      <div className="dc-collab-footer">
        {status !== 'ended' && (
          <Button
            variant="danger"
            onClick={() => {
              leaveSessionKeepingView();
              onClose();
            }}
          >
            Leave session
          </Button>
        )}
        <Button variant="solid" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
