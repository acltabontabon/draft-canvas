import { describe, expect, it, vi } from 'vitest';
import { createExplorerSaver } from '../../src/desktop/saveExplorer';
import { DesktopStore } from '../../src/desktop/store';
import type { ExplorerSaveResult } from '../../src/desktop/api';

const saved = { handle: 'h_saved', name: 'Copy', displayPath: '~/Documents/Copy.draftcanvas', stamp: 'saved-stamp' };

describe('the Save As explorer', () => {
  it('retains the snapshot and sidecar source through replacement confirmation, then resolves the save', async () => {
    const store = new DesktopStore();
    const write = vi.fn<(...args: unknown[]) => Promise<ExplorerSaveResult>>()
      .mockResolvedValueOnce({ outcome: 'exists', name: 'Copy.draftcanvas', stamp: 'original' })
      .mockResolvedValueOnce({ outcome: 'saved', saved });
    const bytes = new TextEncoder().encode('snapshot');
    const startIn = { projectHandle: 'project', relPath: 'rooms' };
    const result = createExplorerSaver({ explorerSaveFile: write }, store)('Copy', bytes, 'source', startIn);
    const request = store.getSnapshot().explorerSave!;
    expect(store.getSnapshot().explorerMode).toBe('save');
    expect(request.startIn).toEqual(startIn);
    await expect(request.save('session', 'folder', 'Copy')).resolves.toMatchObject({ outcome: 'exists' });
    expect(store.getSnapshot().explorerSave).toBe(request);
    await request.save('session', 'folder', 'Copy', 'original');
    await expect(result).resolves.toEqual(saved);
    expect(write).toHaveBeenLastCalledWith('session', 'folder', 'Copy', bytes, 'source', 'original');
    expect(store.getSnapshot().explorerMode).toBeNull();
    expect(store.getSnapshot().explorerSave).toBeNull();
  });

  it('cancels without writing and refuses a save from a closed chooser', async () => {
    const store = new DesktopStore();
    const write = vi.fn<(...args: unknown[]) => Promise<ExplorerSaveResult>>();
    const result = createExplorerSaver({ explorerSaveFile: write }, store)('Copy', new Uint8Array());
    const request = store.getSnapshot().explorerSave!;
    request.cancel();
    await expect(result).resolves.toBeNull();
    await expect(request.save('session', 'folder', 'Copy')).rejects.toThrow('closed');
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps a failed save open for retry and does not erase another explorer mode on cancellation', async () => {
    const store = new DesktopStore();
    const write = vi.fn<(...args: unknown[]) => Promise<ExplorerSaveResult>>().mockRejectedValue(new Error('Read-only folder'));
    const result = createExplorerSaver({ explorerSaveFile: write }, store)('Copy', new Uint8Array());
    const request = store.getSnapshot().explorerSave!;
    await expect(request.save('session', 'folder', 'Copy')).rejects.toThrow('Read-only');
    expect(store.getSnapshot().explorerSave).toBe(request);
    store.update({ explorerMode: 'file' });
    request.cancel();
    await expect(result).resolves.toBeNull();
    expect(store.getSnapshot().explorerMode).toBe('file');
  });
});
