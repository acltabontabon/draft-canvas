import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalNote } from '../src/ui/Library/LocalNote';
import { MemoryRepository } from '../src/storage/MemoryRepository';
import { LAST_BACKUP_PREFERENCE } from '../src/storage/backup';
import { writePreference } from '../src/lib/preferences';
import { BACKUP_COMPLETED_EVENT } from '../src/ui/Library/backupActions';

vi.mock('../src/lib/storagePersistence', () => ({ isStoragePersisted: vi.fn(async () => true) }));

beforeEach(() => writePreference(LAST_BACKUP_PREFERENCE, ''));

describe('backup reminder', () => {
  it('still offers a separate backup when persistent storage has been granted', () => {
    render(<LocalNote hasDocuments durable repository={new MemoryRepository()} />);
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeVisible();
  });

  it('does not remind an empty library, and refreshes after a backup from another control', () => {
    const { rerender } = render(<LocalNote hasDocuments={false} durable repository={new MemoryRepository()} />);
    expect(screen.queryByRole('button', { name: 'Back up now' })).not.toBeInTheDocument();
    rerender(<LocalNote hasDocuments durable repository={new MemoryRepository()} />);
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeVisible();
    act(() => {
      writePreference(LAST_BACKUP_PREFERENCE, new Date().toISOString());
      window.dispatchEvent(new Event(BACKUP_COMPLETED_EVENT));
    });
    expect(screen.queryByRole('button', { name: 'Back up now' })).not.toBeInTheDocument();
  });

  it('does not offer a stored-library backup for memory-only storage or after a recent backup', () => {
    const { rerender } = render(<LocalNote hasDocuments durable={false} repository={new MemoryRepository()} />);
    expect(screen.queryByRole('button', { name: 'Back up now' })).not.toBeInTheDocument();
    writePreference(LAST_BACKUP_PREFERENCE, new Date().toISOString());
    // A fresh mounted note reads the preference, as reopening the Library does.
    rerender(<LocalNote hasDocuments key="new-library" durable repository={new MemoryRepository()} />);
    expect(screen.queryByRole('button', { name: 'Back up now' })).not.toBeInTheDocument();
  });
});
