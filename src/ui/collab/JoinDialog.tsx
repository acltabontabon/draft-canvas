import { useEffect, useId, useRef, useState } from 'react';
import { answerInvite, CollabCodeError, peerConnectionsAvailable, relayUrl, type CollabTransport } from '../../collab/connect';
import { knock, type KnockStatus } from '../../collab/lobby';
import { readName } from '../../collab/protocol';
import { readSessionPayload, rendezvousAvailable } from '../../collab/rendezvous';
import { logDiagnostic } from '../../lib/diagnostics';
import { rejoinByRelay } from './relayGuest';
import { keepLanGuestConnected, lanTokenFromPayload, openLanGuest } from '../../collab/lan';
import { guestSession, joinSession, leaveSession, leaveSessionKeepingView, reconnectSession } from '../../store/collabBridge';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import type { DocumentSession } from '../../store/useDocumentSession';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { copyText } from './clipboard';
import { NameTag } from './NameTag';
import { SessionScene, type SeatState } from './SessionScene';
import { END_MESSAGES, readConnectionPreferences, readDisplayName, writeDisplayName } from './collabCopy';

type Stage =
  | { kind: 'form' }
  | { kind: 'preparing' }
  | { kind: 'waiting'; replyCode: string; copied: boolean }
  | { kind: 'joining' }
  /** At the owner's door, through the relay: what is happening while they decide. */
  | { kind: 'knocking'; status: KnockStatus }
  | { kind: 'failed'; message: string };

/**
 * Joining someone's session from an invite link: say who you are, send back the reply code, and
 * the owner's canvas opens here as soon as they paste it. Opening a fresh invite while a session
 * is reconnecting picks that session back up, unconfirmed edits and all, instead of starting over.
 */
export function JoinDialog({ session, invite }: { session: DocumentSession; invite: string }) {
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [name, setName] = useState(readDisplayName);
  // Whether to ask a STUN server is the owner's call, read from their offer (`followOwner`); only
  // which one is the collaborator's — their own, if they ever set one when hosting.
  const stunServer = readConnectionPreferences().server;
  const cancelJoin = useRef<(() => void) | null>(null);
  /** Whether this began as picking a dropped session back up — read once it is live again. */
  const rejoining = useRef(false);
  const codeId = useId();
  const notify = useUiStore((state) => state.notify);
  const status = useCollabStore((state) => state.status);
  const endReason = useCollabStore((state) => state.endReason);
  const resuming = guestSession() !== null && status === 'reconnecting';
  // A desktop owner's local network link: one link, no reply code, no STUN.
  const lanToken = lanTokenFromPayload(invite);
  // A session link: knock, and the owner lets you in.
  const sessionLink = readSessionPayload(invite);

  const close = () => {
    cancelJoin.current?.();
    // Still waiting at a local network door: walking away leaves, so a later "Let in" opens nothing.
    if (lanToken && stage.kind === 'knocking' && useCollabStore.getState().status !== 'live') leaveSession();
    useUiStore.getState().setJoinInvite(null);
  };

  // Joined: the canvas is open behind the dialog, so the dialog's work is done.
  useEffect(() => {
    if ((stage.kind !== 'joining' && stage.kind !== 'knocking') || status !== 'live') return;
    useUiStore.getState().setJoinInvite(null);
    notify(rejoining.current ? 'Back in the session.' : 'Joined. Edits you make are shared live.');
  }, [stage.kind, status, notify]);
  // Turned away while joining (full, version, removed…): shown as this dialog's failure.
  const shown: Stage =
    (stage.kind === 'joining' || (stage.kind === 'knocking' && lanToken !== null)) && status === 'ended' && endReason
      ? { kind: 'failed', message: END_MESSAGES[endReason] }
      : stage;

  useEffect(() => () => cancelJoin.current?.(), []);

  const beginLan = (token: string, trimmed: string) => {
    // Like a knock: the owner lets each person on the network in, or not.
    setStage({ kind: 'knocking', status: { kind: 'waiting', owner: 'the owner' } });
    const transport = openLanGuest(token);
    const keeper = keepLanGuestConnected(token, transport, {
      reconnect: reconnectSession,
      wanted: () => guestSession() !== null,
      gaveUp: (why) =>
        leaveSessionKeepingView({
          message: why === 'stopped' ? 'The owner stopped sharing on this network.' : 'Couldn’t reach the owner’s computer. Check you’re on the same network, then open the link again.',
          tone: 'error',
        }),
    });
    if (resuming) return reconnectSession(transport);
    joinSession(transport, { name: trimmed, token, open: session.openCollaborative, lost: keeper.lost });
  };

  const beginKnock = async (link: NonNullable<typeof sessionLink>, trimmed: string) => {
    const relay = relayUrl();
    if (!relay || !rendezvousAvailable()) {
      setStage({ kind: 'failed', message: 'This copy of Draft Canvas can’t knock. Ask the owner for a direct invite: Collaborate → Invite one person directly.' });
      return;
    }
    setStage({ kind: 'knocking', status: { kind: 'connecting' } });
    let pending: Awaited<ReturnType<typeof knock>>;
    try {
      pending = await knock(link, relay, { name: trimmed }, stunServer, (status) => setStage({ kind: 'knocking', status }));
    } catch {
      setStage({ kind: 'knocking', status: { kind: 'unavailable' } });
      return;
    }
    cancelJoin.current = pending.cancel;
    const transport = await pending.transport;
    cancelJoin.current = null;
    if (!transport) return;
    setStage({ kind: 'joining' });
    if (resuming) return reconnectSession(transport);
    leaveSession();
    joinSession(transport, { name: trimmed, open: session.openCollaborative, lost: rejoinByRelay(link, relay, trimmed, stunServer) });
  };

  const begin = async () => {
    // As the owner will show it: the same name on both sides.
    const trimmed = readName(name);
    if (!trimmed) return;
    // Checked before any connection is made: joining throws while this tab hosts, and the half-made
    // connection would be left open with the dialog stuck on "joining".
    if (useCollabStore.getState().role === 'host') {
      setStage({ kind: 'failed', message: 'You’re sharing a canvas of your own. End that session, then open this link again.' });
      return;
    }
    writeDisplayName(trimmed);
    rejoining.current = resuming;
    if (lanToken) return beginLan(lanToken, trimmed);
    if (sessionLink) return beginKnock(sessionLink, trimmed);
    setStage({ kind: 'preparing' });
    let transport: Promise<CollabTransport>;
    try {
      const answer = await answerInvite(invite, stunServer);
      cancelJoin.current = answer.cancel;
      transport = answer.transport;
      // Straight onto the clipboard when the browser allows it (the Join click is still recent):
      // the code's only use is to be sent back.
      setStage({ kind: 'waiting', replyCode: answer.replyCode, copied: await copyText(answer.replyCode) });
    } catch (error) {
      logDiagnostic(error, { operation: 'collab-knock' });
      setStage({ kind: 'failed', message: error instanceof CollabCodeError ? error.message : 'This invite couldn’t be read. Ask for a new one.' });
      return;
    }
    let connected: CollabTransport;
    try {
      connected = await transport;
    } catch (error) {
      logDiagnostic(error, { operation: 'collab-knock' });
      setStage({ kind: 'failed', message: 'The owner didn’t connect in time. Ask them for a new invite.' });
      return;
    }
    cancelJoin.current = null;
    setStage({ kind: 'joining' });
    if (guestSession() && useCollabStore.getState().status === 'reconnecting') {
      reconnectSession(connected);
      return;
    }
    leaveSession();
    joinSession(connected, { name: trimmed, open: session.openCollaborative });
  };

  const copy = async (text: string) => {
    if (await copyText(text)) setStage((current) => (current.kind === 'waiting' ? { ...current, copied: true } : current));
    else notify('Couldn’t copy — select the code and copy it yourself.', 'error');
  };

  return (
    <Modal title={resuming ? 'Rejoin the session' : 'Join a live session'} onClose={close} width={500} className="dc-collab-dialog">
      <div className="dc-collab dc-collab-centred">
        <SessionScene
          owner={{ name: shown.kind === 'knocking' && 'owner' in shown.status ? shown.status.owner : '', color: 0 }}
          people={[{ key: 'me', name: name.trim(), color: 1, state: seatOf(shown), you: true }]}
          privacy={
            lanToken ? (
              <span>
                You connect straight to the owner’s computer on this network — nothing goes through the internet. Traffic on the
                network isn’t encrypted, so join on a network you trust.
              </span>
            ) : (
              // How to connect follows the owner's choice (`followOwner`), so there is nothing to pick — only what is asked.
              <span>
                The diagram comes straight from the owner’s browser, encrypted — never through a server.{' '}
                {sessionLink ? 'A relay passes along your request to join, and a STUN server may help you connect: ' : 'A STUN server may help you connect: '}
                they see IP addresses, never the diagram.
              </span>
            )
          }
        />
        {shown.kind === 'form' || shown.kind === 'preparing' ? (
          <>
            <p className="dc-collab-lead">
              {resuming
                ? 'This invite picks your session back up. Anything you changed while disconnected is sent once you’re back.'
                : lanToken
                  ? 'Someone on this network invited you to edit a Draft Canvas diagram with them, from their computer. Their copy stays the one that’s saved.'
                  : sessionLink
                    ? 'You’re invited to draw together, live. Say who you are and ask to join — the owner lets you in.'
                  : 'You’re invited to draw together, live. Say who you are, then send back the code you get.'}
            </p>
            {!lanToken && !peerConnectionsAvailable() ? (
              <p className="dc-collab-error" role="alert">
                This browser can’t make direct connections. Try a current Chrome, Edge, Firefox or Safari.
              </p>
            ) : (
              <form
                className="dc-collab-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void begin();
                }}
              >
                <NameTag value={name} onChange={setName} />
                <Button type="submit" variant="solid" icon="people" className="dc-collab-go" disabled={!readName(name) || shown.kind === 'preparing'} aria-busy={shown.kind === 'preparing'}>
                  {shown.kind === 'preparing' ? 'Preparing…' : resuming ? 'Rejoin' : sessionLink ? 'Ask to join' : 'Join'}
                </Button>
              </form>
            )}
          </>
        ) : shown.kind === 'waiting' ? (
          <div className="dc-collab-steps-single">
            <label className="dc-collab-step-label" htmlFor={codeId}>
              Send this reply code back to the person who invited you
            </label>
            <div className="dc-collab-copy-row">
              <input id={codeId} className="dc-collab-code" value={shown.replyCode} readOnly onFocus={(event) => event.currentTarget.select()} />
              <Button icon={shown.copied ? 'check' : 'copy'} variant={shown.copied ? 'ghost' : 'solid'} onClick={() => void copy(shown.replyCode)}>
                {shown.copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="dc-collab-hint dc-collab-waiting" aria-live="polite">
              {shown.copied ? 'Copied. ' : ''}Send it back, however you sent the invite. This page connects on its own as soon as
              they paste it.
            </p>
          </div>
        ) : shown.kind === 'knocking' ? (
          <KnockProgress status={shown.status} onCancel={close} />
        ) : shown.kind === 'joining' ? (
          <>
            <p className="dc-collab-hint dc-collab-waiting" aria-live="polite">
              Connected. Opening their canvas…
            </p>
          </>
        ) : (
          <>
            <p className="dc-collab-error" role="alert">
              {shown.message}
            </p>
            <div className="dc-collab-actions">
              <Button variant="solid" onClick={close}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** The wait at the owner's door, in words — and what to do when the door can't be reached. */
function KnockProgress({ status, onCancel }: { status: KnockStatus; onCancel: () => void }) {
  const message =
    status.kind === 'connecting'
      ? 'Knocking…'
      : status.kind === 'no-owner'
        ? 'The owner isn’t in the session right now. This page knocks again the moment they are.'
        : status.kind === 'waiting'
          ? `Waiting for ${status.owner} to let you in…`
          : status.kind === 'joining'
            ? `${status.owner} let you in. Connecting…`
            : status.kind === 'denied'
              ? 'The owner didn’t let you in.'
              : status.kind === 'ended'
                ? 'That session has ended.'
                : 'Couldn’t reach the owner automatically. Ask them for a direct invite: Collaborate → Invite one person directly.';
  const settled = status.kind === 'denied' || status.kind === 'ended' || status.kind === 'unavailable';
  return (
    <div className="dc-collab-steps-single">
      <p className={settled ? 'dc-collab-error' : 'dc-collab-hint dc-collab-waiting'} role={settled ? 'alert' : undefined} aria-live="polite">
        {message}
      </p>
      <div className="dc-collab-actions">
        <Button variant={settled ? 'solid' : 'quiet'} onClick={onCancel}>
          {settled ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
  );
}

/** Where the joiner sits in the scene: walking up, at the door, or on their way in. */
function seatOf(stage: Stage): SeatState {
  if (stage.kind === 'joining') return 'joining';
  if (stage.kind === 'waiting') return 'knocking';
  if (stage.kind === 'knocking') return stage.status.kind === 'waiting' || stage.status.kind === 'no-owner' ? 'knocking' : stage.status.kind === 'joining' ? 'joining' : 'arriving';
  return 'arriving';
}
