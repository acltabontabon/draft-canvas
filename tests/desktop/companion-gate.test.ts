import { afterEach, describe, expect, it } from 'vitest';
import { registerDesktopHost } from '../../src/host/hostInfo';
import { useCollabStore } from '../../src/store/collabStore';
import { useUiStore } from '../../src/store/uiStore';
import { companionAllowed } from '../../src/ui/Editor/companionGate';

/** The companion's agent changes the owner's file: only someone who may edit, in the desktop app, gets one. */

afterEach(() => {
  registerDesktopHost(null);
  useUiStore.setState({ readOnly: null });
  useCollabStore.setState({ role: 'off' });
});

describe('companionAllowed', () => {
  it('is the desktop app’s, for the owner while editing', () => {
    expect(companionAllowed(false)).toBe(false);
    registerDesktopHost({} as never);
    expect(companionAllowed(false)).toBe(true);
    expect(companionAllowed(true)).toBe(false);
  });

  it('is never a collaboration guest’s, or offered on a read-only document', () => {
    registerDesktopHost({} as never);
    useCollabStore.setState({ role: 'guest' });
    expect(companionAllowed(false)).toBe(false);
    useCollabStore.setState({ role: 'host' });
    expect(companionAllowed(false)).toBe(true);
    useUiStore.setState({ readOnly: { sharedTitle: 'Orders' } });
    expect(companionAllowed(false)).toBe(false);
  });
});
