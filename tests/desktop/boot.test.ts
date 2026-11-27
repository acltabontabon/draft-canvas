import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFileSaver, downloadText } from '../../src/export/download';
import { exportProjectFile } from '../../src/export';
import { createDocument } from '../../src/document/factory';
import { hostKind, registerDesktopHost } from '../../src/host/hostInfo';
import { useUiStore } from '../../src/store/uiStore';
import { createHarness } from './harness';

// The shell is faked at the one place the app calls it: what Tauri would do is not under test here.
const shell = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/desktop/tauri/api', () => ({ createTauriApi: shell.create }));
// Where history is kept: the shell's, once it has answered. Faked so that is all that is looked at.
const installs = vi.hoisted(() => ({ history: vi.fn(), remote: vi.fn() }));
vi.mock('../../src/desktop/history', () => ({ installDesktopHistory: installs.history }));
vi.mock('../../src/desktop/remoteHistory', () => ({ installRemoteHistory: installs.remote }));

const { bootDesktop } = await import('../../src/desktop/boot');

afterEach(() => {
  registerDesktopHost(null);
  setFileSaver(null);
  useUiStore.setState({ toasts: [] });
  installs.history.mockClear();
  installs.remote.mockClear();
  vi.restoreAllMocks();
});

describe('bootDesktop', () => {
  it('makes the desktop the host, and sends exports to the shell’s Save dialog', async () => {
    const h = createHarness();
    shell.create.mockReturnValue(h.api);

    await bootDesktop();

    expect(hostKind()).toBe('desktop');
    expect(h.api.hostReady).toHaveBeenCalledTimes(1);
    expect(installs.history).toHaveBeenCalledTimes(1);
    expect(installs.remote).toHaveBeenCalledTimes(1);

    await downloadText('<svg/>', 'checkout.svg', 'image/svg+xml');
    const [name, filters, bytes] = h.api.exportFile.mock.calls[0]!;
    expect(name).toBe('checkout.svg');
    expect(filters).toEqual([{ name: 'SVG', extensions: ['svg'] }]);
    expect(new TextDecoder().decode(bytes)).toBe('<svg/>');
  });

  it('exports a document through the same dialog, without a second path for it', async () => {
    const h = createHarness();
    shell.create.mockReturnValue(h.api);
    await bootDesktop();

    await exportProjectFile(createDocument('Payments'));

    expect(h.api.exportFile.mock.calls[0]![0]).toBe('payments.draftcanvas');
  });

  it('treats a cancelled dialog as the user changing their mind, not as a failure', async () => {
    const h = createHarness();
    h.api.exportFile.mockResolvedValueOnce(false);
    shell.create.mockReturnValue(h.api);
    await bootDesktop();

    await expect(downloadText('x', 'a.png', 'image/png')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('says why when the shell refuses an export', async () => {
    const h = createHarness();
    h.api.exportFile.mockRejectedValueOnce(Object.assign(new Error('Draft Canvas couldn’t save a.svg because the disk is full.'), { name: 'DesktopError' }));
    shell.create.mockReturnValue(h.api);
    await bootDesktop();

    await expect(downloadText('x', 'a.svg', 'image/svg+xml')).rejects.toThrow('the disk is full');
  });

  it('falls back to being the web app when the shell cannot be reached, and says so', async () => {
    const h = createHarness();
    h.api.hostReady.mockRejectedValueOnce(new Error('no shell'));
    shell.create.mockReturnValue(h.api);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await bootDesktop();

    expect(hostKind()).toBeNull();
    // Nothing of the desktop's is left behind it: history stays the web app's own.
    expect(installs.history).not.toHaveBeenCalled();
    expect(installs.remote).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts).toEqual([expect.objectContaining({ tone: 'error', message: expect.stringContaining('Restart Draft Canvas') })]);
  });
});
