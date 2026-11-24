import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The invite dialog's chunk cannot be fetched: a tab left open across a deploy asks for a file the
// server no longer has.
vi.mock('../src/ui/collab/JoinDialog', () => {
  throw new Error('Failed to fetch dynamically imported module');
});
vi.mock('virtual:pwa-register', () => ({ registerSW: () => () => {} }));

import { App } from '../src/App';
import { __setRepository, type DraftRepository } from '../src/storage';
import { useUiStore } from '../src/store/uiStore';

const repository = {
  kind: 'memory',
  durable: true,
  list: async () => [],
  load: async () => null,
  has: async () => false,
  save: async () => {},
  remove: async () => {},
  rename: async () => {},
  usage: async () => null,
  listProjects: async () => [],
  saveProject: async () => {},
  deleteProject: async () => {},
  moveDocumentToProject: async () => {},
} as unknown as DraftRepository;

afterEach(() => {
  __setRepository(null);
});

describe('a panel beside the screens that fails to load', () => {
  it('leaves the app up, closes itself and says what happened', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    __setRepository(repository);
    useUiStore.setState(useUiStore.getInitialState(), true);
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector('.dc-home')).not.toBeNull());

    await act(async () => {
      useUiStore.getState().setJoinInvite('an-invite');
    });

    await waitFor(() => expect(useUiStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true));
    expect(useUiStore.getState().toasts.at(-1)!.message).toMatch(/invitation couldn’t open|Reload/i);
    expect(useUiStore.getState().joinInvite).toBeNull();
    // An error that reaches the root unmounts everything: Home must still be on screen.
    expect(container.querySelector('.dc-home')).not.toBeNull();
    quiet.mockRestore();
  });
});
