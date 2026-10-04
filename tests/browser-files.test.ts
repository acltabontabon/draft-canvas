import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import { serializeDocument } from '../src/export/project';
import { BrowserFiles, contentFingerprint, fingerprint } from '../src/storage/browserFiles';
import { MemoryRepository } from '../src/storage/MemoryRepository';
import type { BrowserFileAdapter, FileAssociation, LocalFileHandle } from '../src/storage/fileHandles';
import type { DocumentSession } from '../src/store/useDocumentSession';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { __setRepository } from '../src/storage';

class FileRepository extends MemoryRepository {
  links = new Map<string, FileAssociation>();
  async listFileAssociations() { return [...this.links.values()]; }
  async putFileAssociation(value: FileAssociation) { this.links.set(value.documentId, value); }
  override async remove(id: string) { await super.remove(id); this.links.delete(id); }
}

function fileHandle(name: string, initial: string) {
  let text = initial;
  let fail = false;
  let permission: PermissionState = 'granted';
  let beforeClose: (() => void) | undefined;
  const handle: LocalFileHandle = {
    name,
    async getFile() { return { name, size: new TextEncoder().encode(text).length, text: async () => text } as File; },
    async queryPermission() { return permission; },
    async requestPermission() { return permission; },
    async isSameEntry(other) { return other === handle; },
    async createWritable() {
      let pending = '';
      return { async write(value) { if (fail) throw new Error('Drive unavailable'); pending = value; }, async close() { beforeClose?.(); text = pending; }, async abort() {} };
    },
  };
  return { handle, text: () => text, replace: (value: string) => { text = value; }, fail: () => { fail = true; }, deny: () => { permission = 'denied'; }, beforeClose: (fn: () => void) => { beforeClose = fn; } };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  __resetInteraction();
  useUiStore.setState({ readOnly: null, flowTrace: null, fileQuestion: null, browserFileLabels: {}, browserFileNames: {} });
  useEditorStore.getState().setDocument(createDocument('Orders'));
  useEditorStore.setState({ save: { status: 'saved' } });
});

async function setup(linked = true) {
  const repo = new FileRepository();
  __setRepository(repo);
  const original = useEditorStore.getState().document;
  await repo.save(original);
  const file = fileHandle('orders.draftcanvas', serializeDocument(original));
  const second = fileHandle('other.draftcanvas', '');
  let destination: LocalFileHandle | null = second.handle;
  const adapter: BrowserFileAdapter = { open: async () => file.handle, save: async () => destination, exclusive: async (work) => work() };
  const session = {
    openId: original.metadata.id,
    closeDocument: async () => true,
    openDocument: async (id: string) => { session.openId = id; useEditorStore.getState().setDocument((await repo.load(id))!); },
    adoptDocument: async (document: typeof original) => { await repo.save(document); session.openId = document.metadata.id; useEditorStore.getState().setDocument(document); },
  } as DocumentSession;
  if (linked) await repo.putFileAssociation({ documentId: original.metadata.id, handle: file.handle, diskHash: await fingerprint(file.text()), savedContentHash: await contentFingerprint(original), savedAt: null });
  const files = new BrowserFiles(repo, adapter, () => session);
  await files.initialize();
  return { repo, files, file, second, original, session, destination: (next: LocalFileHandle | null) => { destination = next; } };
}

async function answer(id: string) {
  await vi.waitFor(() => expect(useUiStore.getState().fileQuestion).not.toBeNull());
  useUiStore.getState().fileQuestion!.answer(id);
}

describe('browser file lifecycle', () => {
  it('writes the same portable bytes as export, and keeps newer edits dirty', async () => {
    const { files, file, original } = await setup();
    useEditorStore.getState().rename('Updated orders');
    const expected = serializeDocument(useEditorStore.getState().document);
    file.beforeClose(() => useEditorStore.getState().rename('Edited during save'));
    await files.save();
    expect(file.text()).toBe(expected);
    expect(useUiStore.getState().browserFileLabels[original.metadata.id]).toContain('not updated');
  });

  it('does not write on permission refusal or switch associations after failed Save As', async () => {
    const { files, file, second, repo, original } = await setup();
    file.deny();
    const before = file.text();
    useEditorStore.getState().rename('Unsaved');
    await files.save();
    expect(file.text()).toBe(before);
    expect(useUiStore.getState().browserFileLabels[original.metadata.id]).toContain('Permission');
    second.fail();
    await files.save(true);
    expect(repo.links.get(original.metadata.id)!.handle).toBe(file.handle);
    expect(useEditorStore.getState().document.metadata.title).toBe('Unsaved');
  });

  it('requires a decision before overwriting externally changed content', async () => {
    const { files, file } = await setup();
    const outside = serializeDocument(createDocument('Outside edit'));
    file.replace(outside);
    useEditorStore.getState().rename('My edit');
    const pending = files.save();
    await answer('cancel');
    await pending;
    expect(file.text()).toBe(outside);
    const overwrite = files.save();
    await answer('overwrite');
    await overwrite;
    expect(JSON.parse(file.text()).metadata.title).toBe('My edit');
  });

  it('keeps recovered and disk versions untouched when a reopen conflict is cancelled', async () => {
    const { files, file, repo, original } = await setup();
    useEditorStore.getState().rename('Recovered edit');
    await repo.save(useEditorStore.getState().document);
    const disk = serializeDocument(createDocument('Outside'));
    file.replace(disk);
    const pending = files.refreshOnOpen(original.metadata.id);
    await answer('cancel');
    expect(await pending).toBe(false);
    expect((await repo.load(original.metadata.id))!.metadata.title).toBe('Recovered edit');
    expect(file.text()).toBe(disk);
  });

  it('refreshes an unchanged recovery from disk and does not request permissions on reopen', async () => {
    const { files, file, repo, original } = await setup();
    file.replace(serializeDocument(createDocument('New on disk')));
    expect(await files.refreshOnOpen(original.metadata.id)).toBe(true);
    expect((await repo.load(original.metadata.id))!.metadata.title).toBe('New on disk');
    file.deny();
    expect(await files.refreshOnOpen(original.metadata.id)).toBe(true);
    expect(useUiStore.getState().browserFileLabels[original.metadata.id]).toContain('permission');
  });

  it('handles picker cancellation and reopens the same handle without another library item', async () => {
    const { files, repo, original, destination } = await setup();
    destination(null);
    await files.save(true);
    expect(repo.links.get(original.metadata.id)!.handle.name).toBe('orders.draftcanvas');
    await files.open();
    expect(await repo.list()).toHaveLength(1);
  });

  it('opens a different file with a colliding document id as a separate document', async () => {
    const { files, repo, original } = await setup(false);
    await files.open();
    expect(await repo.list()).toHaveLength(2);
    expect(useEditorStore.getState().document.metadata.id).not.toBe(original.metadata.id);
  });

  it('blocks file writes while browser recovery has a conflict', async () => {
    const { files, file } = await setup();
    const before = file.text();
    useEditorStore.getState().rename('Mine');
    useEditorStore.setState({ save: { status: 'error', conflict: 'changed' } });
    await files.save();
    expect(file.text()).toBe(before);
  });

  it('does not let pan or save timestamps make content dirty', async () => {
    const document = createDocument('Camera');
    expect(await contentFingerprint({ ...document, viewport: { x: 100, y: 100, zoom: 2 }, metadata: { ...document.metadata, updatedAt: 999 } })).toBe(await contentFingerprint(document));
  });
});

it('asks before omitting a configured background and cancellation keeps the disk untouched', async () => {
  const { files, file } = await setup();
  const before = file.text();
  useEditorStore.getState().apply('Background', doc => ({ ...doc, settings: { ...doc.settings, background: { ...doc.settings.background, enabled: true, imageId: 'missing' } } }));
  const pending = files.save();
  await answer('cancel');
  await pending;
  expect(file.text()).toBe(before);
  expect(useEditorStore.getState().document.settings.background.enabled).toBe(true);
});

it('embeds a stored background through the same portable export pipeline', async () => {
  const { files, file, repo, original } = await setup();
  await repo.saveBackgroundImage(original.metadata.id, new Blob(['image bytes'], { type: 'image/png' }), { width: 2, height: 2 }, 'background');
  useEditorStore.getState().apply('Background', doc => ({ ...doc, settings: { ...doc.settings, background: { ...doc.settings.background, enabled: true, imageId: 'background' } } }));
  await files.save();
  expect(JSON.parse(file.text()).settings.background.image).toEqual({ dataUri: 'data:image/png;base64,aW1hZ2UgYnl0ZXM=', width: 2, height: 2 });
  expect(useEditorStore.getState().document.settings.background.image).toBeUndefined();
});

it('detects another tab updating the saved baseline before a stale tab writes', async () => {
  const { files, file, repo, session } = await setup();
  let exclusiveCalls = 0;
  const other = new BrowserFiles(repo, { open: async () => file.handle, save: async () => file.handle,
    exclusive: async work => { exclusiveCalls++; return work(); } }, () => session);
  await other.initialize();
  useEditorStore.getState().rename('First tab');
  await files.save();
  const disk = file.text();
  useEditorStore.getState().rename('Stale second tab');
  const pending = other.save();
  await answer('cancel');
  await pending;
  expect(file.text()).toBe(disk);
  expect(exclusiveCalls).toBe(1);
});
