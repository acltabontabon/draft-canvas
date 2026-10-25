import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLLAB_AT_REST, useCollabStore } from '../../src/store/collabStore';
import { endHeadline } from '../../src/ui/collab/collabCopy';
import { SessionEnded } from '../../src/ui/collab/SessionEnded';

afterEach(() => useCollabStore.setState(COLLAB_AT_REST, true));

function ended(reason: NonNullable<typeof COLLAB_AT_REST.endReason>, owner: { name: string; color: number } | null = { name: 'Olive', color: 0 }) {
  useCollabStore.setState({ ...COLLAB_AT_REST, role: 'guest', status: 'ended', endReason: reason, endedOwner: owner, selfName: 'Gus', selfColor: 3 });
}

describe('SessionEnded', () => {
  it('says who ended it and how, falling back to "the owner" without a name', () => {
    expect(endHeadline('ended', 'Olive')).toBe('Olive ended the session');
    expect(endHeadline('owner-left', 'Olive')).toBe('Olive closed the canvas');
    expect(endHeadline('document-changed', 'Olive')).toBe('Olive moved to another canvas');
    expect(endHeadline('removed', 'Olive')).toBe('Olive removed you from the session');
    expect(endHeadline('timeout', 'Olive')).toBe('Lost the line to Olive');
    expect(endHeadline('timeout', null)).toBe('Lost the line to the owner');
    expect(endHeadline('ended', '  ')).toBe('The owner ended the session');
    expect(endHeadline('protocol', 'Olive')).toBe('The session ended');
  });

  it('is a modal dialog named by its headline, with keeping a copy first and focused', () => {
    ended('ended');
    const onKeep = vi.fn();
    const onHome = vi.fn();
    render(<SessionEnded exportOnly={false} onKeep={onKeep} onHome={onHome} />);
    const dialog = screen.getByRole('dialog', { name: 'Olive ended the session' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('data-cut')).toBe('owner');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep a copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep a copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to home' }));
    expect(onKeep).toHaveBeenCalledOnce();
    expect(onHome).toHaveBeenCalledOnce();
  });

  it('offers no copy to someone the owner removed: only the way home, focused, with their own line snipped', () => {
    ended('removed');
    const onHome = vi.fn();
    render(<SessionEnded exportOnly={false} onKeep={() => {}} onHome={onHome} />);
    const dialog = screen.getByRole('dialog', { name: 'Olive removed you from the session' });
    expect(dialog.getAttribute('data-cut')).toBe('self');
    expect(dialog.getAttribute('data-keepable')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Keep a copy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export a copy' })).toBeNull();
    expect(dialog.textContent).toContain('nothing of it stays on this device');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back to home' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to home' }));
    expect(onHome).toHaveBeenCalledOnce();
  });

  it('removed over the local network link: still no export', () => {
    ended('removed');
    render(<SessionEnded exportOnly onKeep={() => {}} onHome={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Export a copy' })).toBeNull();
  });

  it('frays the owner’s line when the connection went', () => {
    ended('timeout');
    render(<SessionEnded exportOnly={false} onKeep={() => {}} onHome={() => {}} />);
    expect(screen.getByRole('dialog').getAttribute('data-cut')).toBe('fray');
  });

  it('offers an export over the local network link, and says the copy here was never saved', () => {
    ended('protocol', null);
    render(<SessionEnded exportOnly onKeep={() => {}} onHome={() => {}} />);
    expect(screen.getByRole('button', { name: 'Export a copy' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep a copy' })).toBeNull();
    expect(screen.getByRole('dialog').textContent).toContain('isn’t saved anywhere on this device');
    expect(screen.getByRole('dialog').textContent).toContain('The connection sent something unreadable');
  });
});
