import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeDocument } from '../../src/export/project';
import { createDocument, createNode } from '../../src/document/factory';
import { readMarker, type DocsSettings } from '../../src/export/docs/marker';
import { DocsPublisher } from '../../src/desktop/docs';
import type { DesktopApi } from '../../src/desktop/api';
import { createHarness, type Harness } from './harness';

let h: Harness;

beforeEach(async () => {
  h = createHarness();
  await h.controller.start();
});

const follow: DocsSettings = { view: [], theme: 'light', style: 'clean', sync: true };

function withService(title: string, label: string): string {
  const doc = createDocument(title);
  doc.nodes.push(createNode({ type: 'service', x: 0, y: 0, text: label }));
  return serializeDocument(doc);
}

async function openFile(name = 'payments', text?: string) {
  const handle = h.addFile(name, text);
  await h.controller.openHandle(handle);
  await h.settle();
  return handle;
}

async function drained() {
  for (let i = 0; i < 10; i += 1) {
    await h.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('publishing beside the file', () => {
  it('writes the picture of the saved file, with its source and settings in the note', async () => {
    const handle = await openFile('payments', withService('Payments', 'Gateway'));
    const result = await h.controller.publishDocs(follow);
    expect(result).toEqual({ outcome: 'written', imageName: 'payments.svg' });
    const svg = h.docsImages.get(handle)!;
    expect(svg).toContain('Gateway');
    expect(readMarker(svg)).toEqual({ source: 'payments.draftcanvas', settings: follow });
    // Again, with nothing changed: the shell is asked, and says the bytes are the same.
    expect(await h.controller.publishDocs(follow)).toEqual({ outcome: 'unchanged', imageName: 'payments.svg' });
  });

  it('saves unsaved changes first, so the picture matches its file', async () => {
    const handle = await openFile('payments', withService('Payments', 'Gateway'));
    h.edit(withService('Payments', 'Edge router'));
    expect(h.controller.docsFile()?.dirty).toBe(true);
    await h.controller.publishDocs(follow);
    expect(h.files.get(handle)!.text).toContain('Edge router');
    expect(h.docsImages.get(handle)).toContain('Edge router');
  });

  it('refuses a draft with no file', async () => {
    await h.controller.newQuickDraft();
    await expect(h.controller.publishDocs(follow)).rejects.toThrow();
  });
});

describe('keeping it updated', () => {
  it('redraws a picture that follows saves when the file is saved, and leaves a snapshot alone', async () => {
    const handle = await openFile('payments', withService('Payments', 'Gateway'));
    await h.controller.publishDocs(follow);
    h.api.docsPublish.mockClear();

    h.edit(withService('Payments', 'Edge router'));
    await h.controller.save();
    await drained();
    expect(h.api.docsPublish).toHaveBeenCalledTimes(1);
    expect(h.docsImages.get(handle)).toContain('Edge router');

    await h.controller.publishDocs({ ...follow, sync: false });
    h.api.docsPublish.mockClear();
    h.edit(withService('Payments', 'Gateway again'));
    await h.controller.save();
    await drained();
    expect(h.api.docsPublish).not.toHaveBeenCalled();
    expect(h.docsImages.get(handle)).toContain('Edge router');
  });

  it('never touches a picture Draft Canvas did not make, or a file with none', async () => {
    const handle = await openFile();
    h.edit(withService('Payments', 'Changed'));
    await h.controller.save();
    await drained();
    expect(h.api.docsStatus).toHaveBeenCalledWith(handle);
    expect(h.api.docsPublish).not.toHaveBeenCalled();

    h.docsImages.set(handle, '<svg><rect/></svg>');
    h.edit(withService('Payments', 'Changed again'));
    await h.controller.save();
    await drained();
    expect(h.api.docsPublish).not.toHaveBeenCalled();
    expect(h.docsImages.get(handle)).toBe('<svg><rect/></svg>');
  });

  it('follows an agent’s change to a closed file once the shell has written it', async () => {
    await openFile('open-one');
    const other = h.addFile('ledger', withService('Ledger', 'Before'));
    // Published earlier; the file is not open now.
    h.docsImages.set(other, `<svg>${'<metadata id="draftcanvas-docs">'}${JSON.stringify({ v: 1, source: 'ledger.draftcanvas', view: [], theme: 'light', style: 'clean', sync: true })}</metadata></svg>`);
    const { rememberPendingWrite } = await import('../../src/desktop/agentWrites');
    rememberPendingWrite(77, { title: 'Ledger', before: h.files.get(other)!.text, after: withService('Ledger', 'After') });
    await h.hostEvent({ type: 'agent-file-written', id: 77, handle: other, displayPath: h.files.get(other)!.displayPath, stamp: 'v1:2', created: false });
    await drained();
    expect(h.docsImages.get(other)).toContain('After');
  });
});

describe('the publisher', () => {
  function fakeApi(svg: string | null, publish = vi.fn(async () => ({ outcome: 'written' as const, imageName: 'p.svg' }))) {
    return {
      docsStatus: vi.fn(async () => ({ imageName: 'p.svg', state: svg ? ('ours' as const) : ('none' as const), svg, modifiedMs: null })),
      docsPublish: publish,
    } as unknown as DesktopApi & { docsPublish: typeof publish };
  }
  const note = (settings: DocsSettings) =>
    `<svg><metadata id="draftcanvas-docs">${JSON.stringify({ v: 1, source: 'p.draftcanvas', ...settings })}</metadata></svg>`;

  it('draws once per file at a time, the latest saved text winning', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const written: string[] = [];
    const publish = vi.fn(async (_handle: string, svg: string) => {
      written.push(svg);
      await gate;
      return { outcome: 'written' as const, imageName: 'p.svg' };
    });
    const api = fakeApi(note(follow), publish as never);
    const publisher = new DocsPublisher(api, () => {});
    const first = publisher.refresh('h', 'p', withService('P', 'One'));
    await drained();
    void publisher.refresh('h', 'p', withService('P', 'Two'));
    void publisher.refresh('h', 'p', withService('P', 'Three'));
    release();
    await first;
    await drained();
    expect(written).toHaveLength(2);
    expect(written[0]).toContain('One');
    expect(written[1]).toContain('Three');
  });

  it('says once, not every save, that the level it shows is gone', async () => {
    const notices: string[] = [];
    const api = fakeApi(note({ ...follow, view: ['gone'] }));
    const publisher = new DocsPublisher(api, (message) => notices.push(message));
    await publisher.refresh('h', 'p', withService('P', 'One'));
    await publisher.refresh('h', 'p', withService('P', 'Two'));
    expect(api.docsPublish).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('p.svg');
  });

  it('reports a failed write without throwing into the save', async () => {
    const notices: string[] = [];
    const publish = vi.fn(async () => {
      throw new Error('the disk is full');
    });
    const publisher = new DocsPublisher(fakeApi(note(follow), publish as never), (message) => notices.push(message));
    await expect(publisher.refresh('h', 'p', withService('P', 'One'))).resolves.toBeUndefined();
    expect(notices[0]).toBe('Couldn’t update p.svg: the disk is full');
  });
});
