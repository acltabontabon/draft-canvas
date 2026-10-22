import { afterEach, describe, expect, it } from 'vitest';
import { startLanSharing, type LanRelayEvent } from '../../src/collab/lan';
import type { CollabTransport } from '../../src/collab/transport/types';
import { isCollabLanEvent, onCollabLanEvent } from '../../src/desktop/collabLan';
import { insideDesktopShell } from '../../src/desktop/tauri/shell';
import { hostKind } from '../../src/host/hostInfo';
import { createHarness } from '../desktop/harness';

const globals = globalThis as Record<string, unknown>;

afterEach(() => {
  delete globals.isTauri;
  delete globals.__TAURI_INTERNALS__;
});

describe('starting the desktop build outside the desktop app', () => {
  it('knows a plain browser (a LAN guest’s) has no shell, so it boots as the web app', () => {
    expect(insideDesktopShell()).toBe(false);
    // Nothing registered a desktop host: the app takes the web path, where `#join=` is read.
    expect(hostKind()).toBeNull();
  });

  it('knows the desktop app’s own window', () => {
    Object.defineProperty(globalThis, 'isTauri', { value: true, configurable: true });
    expect(insideDesktopShell()).toBe(true);
  });

  it('recognises a stand-in bridge without the flag (the desktop e2e suite’s mock shell)', () => {
    globals.__TAURI_INTERNALS__ = { convertFileSrc: (path: string) => path };
    expect(insideDesktopShell()).toBe(true);
  });
});

describe('the shell’s LAN events', () => {
  it('reach whoever is sharing, through the controller, and nothing else does', async () => {
    const h = createHarness();
    await h.controller.start();
    const heard: LanRelayEvent[] = [];
    const off = onCollabLanEvent((event) => heard.push(event));

    h.hostEvent({ type: 'collab-lan-open', connId: 'c1' });
    h.hostEvent({ type: 'collab-lan-message', connId: 'c1', text: '{"t":"hello"}' });
    h.hostEvent({ type: 'collab-lan-close', connId: 'c1', reason: 'closed' });
    h.hostEvent({ type: 'collab-lan-stopped', reason: 'window-closed' });
    h.hostEvent({ type: 'recents-changed' });
    off();
    h.hostEvent({ type: 'collab-lan-open', connId: 'c2' });

    expect(heard.map((event) => event.type)).toEqual(['collab-lan-open', 'collab-lan-message', 'collab-lan-close', 'collab-lan-stopped']);
    expect(isCollabLanEvent({ type: 'recents-changed' })).toBe(false);
  });

  it('drive a sharing session end to end through the controller’s relay', async () => {
    const h = createHarness();
    await h.controller.start();
    const transports: CollabTransport[] = [];
    const sharing = await startLanSharing(h.controller.lanRelay(), { onTransport: (transport) => transports.push(transport) });

    expect(h.api.collabLanStart).toHaveBeenCalledWith({ token: sharing.token });
    expect(sharing.links).toEqual([`http://192.168.1.20:49152/#join=lan.${sharing.token}`]);

    h.hostEvent({ type: 'collab-lan-open', connId: 'c1' });
    const messages: string[] = [];
    transports[0]!.onMessage((message) => messages.push(message));
    h.hostEvent({ type: 'collab-lan-message', connId: 'c1', text: 'hello' });
    transports[0]!.send('welcome', 'commit');
    await h.settle();

    expect(messages).toEqual(['hello']);
    expect(h.api.collabLanSend).toHaveBeenCalledWith('c1', 'welcome');

    await sharing.stop();
    expect(transports[0]!.state).toBe('closed');
    expect(h.api.collabLanStop).toHaveBeenCalledTimes(1);
  });
});
