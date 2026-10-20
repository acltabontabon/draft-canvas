import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalNote } from '../src/ui/Library/LocalNote';
import { MemoryRepository } from '../src/storage/MemoryRepository';
import { LAST_BACKUP_PREFERENCE } from '../src/storage/backup';
import { writePreference } from '../src/lib/preferences';
import { BACKUP_COMPLETED_EVENT } from '../src/ui/Library/backupActions';

vi.mock('../src/lib/storagePersistence', () => ({ isStoragePersisted: vi.fn(async () => true) }));

beforeEach(() => writePreference(LAST_BACKUP_PREFERENCE, ''));

describe('backup reminder', () => {
  it('keeps the backup action visible while the longer explanation stays behind Details', async () => {
    render(<LocalNote hasDocuments durable repository={new MemoryRepository()} />);
    const details = screen.getByRole('button', { name: /Stored on this device/ });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('No recent backup')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeVisible();
    expect(screen.queryByText(/Your last backup is missing/)).not.toBeInTheDocument();
    await userEvent.click(details);
    expect(screen.getByText(/Your last backup is missing/)).toBeVisible();
    expect(screen.getByText(/Clearing this browser/)).toBeVisible();
  });

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
