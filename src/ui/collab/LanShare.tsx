import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { linkLabel, startLanSharing, type CollabTransport, type LanSharing } from '../../collab/lan';
import { getDesktopController } from '../../desktop/useDesktop';
import { hostKind } from '../../host/hostInfo';
import { holdAtDoor, type AtTheDoor } from '../../collab/door';
import { announce } from '../../lib/announce';
import type { Role } from '../../collab/protocol';
import { sameSecret } from '../../collab/rendezvous';
import { attachCollaborator, hostSession, setLanKnockHandler } from '../../store/collabBridge';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { copyText } from './clipboard';
import '../../styles/lan.css';

/**
 * "Also share on this network": the desktop owner's switch for the app's LAN relay, shown in the
 * Collaborate dialog while a session runs. People on the same network open the link in a browser
 * and join as editors; no invite or reply code. Sharing outlives the dialog — closing it doesn't
 * stop anything — and stops with the session, when switched off, or when the window closes.
 *
 * The state lives here at module level rather than in the component, for exactly that reason.
 */

type LanState =
  | { status: 'off'; notice: string | null }
  | { status: 'starting' }
  | { status: 'on'; links: readonly string[]; connected: number }
  | { status: 'error'; message: string };

const OFF: LanState = { status: 'off', notice: null };

let state: LanState = OFF;
let sharing: LanSharing | null = null;
/** Bumped by every start and stop, so a start that finishes after a stop is undone, not shown. */
let generation = 0;
let connected = 0;
let unwatchSession: (() => void) | null = null;
const listeners = new Set<() => void>();

function setState(next: LanState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function getState(): LanState {
  return state;
}

function setConnected(count: number): void {
  connected = Math.max(0, count);
  if (state.status === 'on') setState({ ...state, connected });
}

/** People waiting at the door who came by the local network link, by their `lan:` id. */
const waiting = new Map<string, AtTheDoor>();
const MAX_WAITING = 12;

function publishWaiting(): void {
  useCollabStore.setState({ lanKnocks: [...waiting.entries()].map(([id, door]) => ({ id, name: door.name, at: Date.now() })) });
}

/**
 * Someone on the network opened the link: they wait at the same door as anyone knocking through the
 * relay, and the owner lets them in or not — a link (and a network) can reach people the owner
 * didn't mean to invite. Coming back after a drop with their place's key, they go straight back in;
 * the session checks that key itself before giving the place back.
 */
async function admitAtDoor(transport: CollabTransport, run: number): Promise<void> {
  const door = await holdAtDoor(transport);
  if (!door || run !== generation) return void door?.refuse();
  const back = door.returning ? hostSession()?.waitingPlace(door.returning.peer) : null;
  if (back && door.returning && sameSecret(back.key, door.returning.key)) {
    return attachCollaborator(door.admit(), back.role, door.returning.peer, true);
  }
  if (waiting.size >= MAX_WAITING) return door.refuse();
  const id = `lan:${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
  waiting.set(id, door);
  announce(`${door.name} is asking to join.`);
  door.onGone(() => {
    waiting.delete(id);
    publishWaiting();
  });
  publishWaiting();
}

function answerAtDoor(id: string, role: Role | null): void {
  const door = waiting.get(id);
  if (!door) return;
  waiting.delete(id);
  publishWaiting();
  if (role) attachCollaborator(door.admit(), role);
  else door.refuse();
}

setLanKnockHandler(answerAtDoor);

function clearWaiting(): void {
  for (const door of waiting.values()) door.refuse();
  waiting.clear();
  publishWaiting();
}

/** Counts a guest while their connection is up. */
function track(transport: CollabTransport): void {
  setConnected(connected + 1);
  let counted = true;
  const off = transport.onState((next) => {
    if (next !== 'closed' || !counted) return;
    counted = false;
    off();
    setConnected(connected - 1);
  });
}

function stoppedNotice(reason: string): string {
  return reason === 'window-closed'
    ? 'Network sharing stopped when the window closed. Turn it on again for a new link.'
    : 'Network sharing stopped. Turn it on again for a new link.';
}

function startFailure(error: unknown): string {
  const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
  return `Couldn’t share on this network.${detail}`;
}

async function startSharing(): Promise<void> {
  if (state.status === 'starting' || state.status === 'on') return;
  if (!hostSession()) return;
  const run = ++generation;
  connected = 0;
  setState({ status: 'starting' });
  // The session ending mid-start stops this too.
  watchSession();
  try {
    const next = await startLanSharing(getDesktopController().lanRelay(), {
      onTransport: (transport) => {
        if (run !== generation) return transport.close('stopped');
        track(transport);
        void admitAtDoor(transport, run);
      },
      onStopped: (reason) => {
        if (run !== generation) return;
        generation++;
        sharing = null;
        connected = 0;
        setState({ status: 'off', notice: stoppedNotice(reason) });
      },
    });
    if (run !== generation) {
      void next.stop().catch((error: unknown) => console.error(error));
      return;
    }
    if (next.links.length === 0) {
      generation++;
      void next.stop().catch((error: unknown) => console.error(error));
      setState({ status: 'error', message: 'This computer isn’t on a network right now. Connect to Wi‑Fi or Ethernet, then try again.' });
      return;
    }
    sharing = next;
    setState({ status: 'on', links: next.links, connected });
  } catch (error) {
    if (run !== generation) return;
    generation++;
    setState({ status: 'error', message: startFailure(error) });
  }
}

/** Turns sharing off: every network guest is disconnected and the link stops working. */
function stopSharing(notice: string | null = null): void {
  generation++;
  clearWaiting();
  const current = sharing;
  sharing = null;
  connected = 0;
  stopWatchingSession();
  setState({ status: 'off', notice });
  // A start still in flight sees the new generation and stops what it started.
  if (current) void current.stop().catch((error: unknown) => console.error(error));
}

/**
 * Until the switch is turned off, the session's end turns sharing off — and clears a notice or an
 * error left from this session, so the next one starts clean.
 */
function watchSession(): void {
  if (unwatchSession) return;
  unwatchSession = useCollabStore.subscribe((collab) => {
    if (collab.role !== 'host') stopSharing();
  });
}

function stopWatchingSession(): void {
  unwatchSession?.();
  unwatchSession = null;
}

/** The panel, for the Collaborate dialog while hosting. Renders nothing outside the desktop app. */
export function LanShare() {
  if (!__DESKTOP__ || hostKind() !== 'desktop') return null;
  return <LanSharePanel />;
}

function LanSharePanel() {
  const lan = useSyncExternalStore(subscribe, getState, getState);
  const role = useCollabStore((collab) => collab.role);
  const notify = useUiStore((ui) => ui.notify);
  const titleId = useId();
  const hintId = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);

  const best = lan.status === 'on' ? (lan.links[0] ?? null) : null;

  if (role !== 'host') return null;

  const on = lan.status === 'on' || lan.status === 'starting';
  const others = lan.status === 'on' ? lan.links.slice(1) : [];

  const copy = async (link: string) => {
    if (await copyText(link)) {
      setCopied(link);
      return;
    }
    if (link === best) linkInput.current?.select();
    notify('Couldn’t copy — select the link and copy it yourself.', 'error');
  };

  return (
    <section className="dc-collab-section dc-lan" aria-labelledby={titleId} data-status={lan.status}>
      <div className="dc-lan-head">
        <div className="dc-lan-text">
          <span id={titleId} className="dc-lan-title">
            Also share on this network
          </span>
          <p id={hintId} className="dc-collab-hint">
            People on the same Wi‑Fi open a link in their browser and ask to join — no app, no code. You let them in.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          className="dc-lan-switch"
          aria-checked={on}
          aria-labelledby={titleId}
          aria-describedby={hintId}
          aria-busy={lan.status === 'starting' || undefined}
          disabled={lan.status === 'starting'}
          onClick={() => (on ? stopSharing() : void startSharing())}
        >
          <span className="dc-lan-thumb" aria-hidden="true" />
        </button>
      </div>

      {lan.status === 'on' && best && (
        <div className="dc-lan-body">
          <div className="dc-collab-copy-row">
            <input
              ref={linkInput}
              className="dc-collab-code"
              value={best}
              readOnly
              aria-label="Link for people on this network"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button icon={copied === best ? 'check' : 'copy'} variant={copied === best ? 'ghost' : 'solid'} onClick={() => void copy(best)}>
              {copied === best ? 'Copied' : 'Copy'}
            </Button>
          </div>

          {others.length > 0 && (
            <div className="dc-lan-others">
              <p className="dc-collab-hint">Doesn’t open for someone? Try another address for this computer — on a VPN or a second network, say:</p>
              <ul className="dc-lan-addresses">
                {others.map((link) => (
                  <li key={link}>
                    <code title={link}>{linkLabel(link)}</code>
                    <Button
                      icon={copied === link ? 'check' : 'copy'}
                      variant="quiet"
                      aria-label={`Copy the link for ${linkLabel(link)}`}
                      onClick={() => void copy(link)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="dc-lan-status-row">
            <p className="dc-lan-status" role="status">
              <span className="dc-lan-dot" aria-hidden="true" />
              {lan.connected === 0
                ? 'Waiting for someone to open the link.'
                : `${lan.connected} ${lan.connected === 1 ? 'person' : 'people'} connected from this network.`}
            </p>
            <Button variant="quiet" onClick={() => stopSharing()}>
              Stop
            </Button>
          </div>

          <p className="dc-lan-warning">
            <Icon name="alert" />
            <span>
              Anyone with the link can ask to join while this is on. Traffic on the network isn’t encrypted, so use it on a network you
              trust — or over Tailscale. Stopping makes the link stop working.
            </span>
          </p>
        </div>
      )}

      {lan.status === 'starting' && (
        <p className="dc-collab-hint" role="status">
          Starting…
        </p>
      )}
      {lan.status === 'error' && (
        <p className="dc-collab-error" role="alert">
          {lan.message}
        </p>
      )}
      {lan.status === 'off' && lan.notice && (
        <p className="dc-collab-hint" role="status">
          {lan.notice}
        </p>
      )}
    </section>
  );
}
