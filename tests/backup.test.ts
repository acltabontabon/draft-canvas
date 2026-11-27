import { describe, expect, it, vi } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import type { DraftDocument } from '../src/document/types';
import { unzipFiles, zipFiles } from '../src/export/zip';
import { backupFileName, backupIsStale, buildBackup, describeRestore, restoreBackup, worthBackingUp } from '../src/storage/backup';
import { MemoryRepository } from '../src/storage/MemoryRepository';
import { setFileSaver } from '../src/export/download';
import { backUpLibrary, NOT_A_BACKUP, restoreLibrary } from '../src/ui/Library/backupActions';
import { readPreference, writePreference } from '../src/lib/preferences';
import { LAST_BACKUP_PREFERENCE } from '../src/storage/backup';

function documentWith(title: string, projectId?: string): DraftDocument {
  const doc = addNodes(createDocument(title), [createNode({ type: 'service', x: 0, y: 0, text: `${title} API` })]);
  return projectId ? { ...doc, metadata: { ...doc.metadata, projectId } } : doc;
}

async function seeded(): Promise<{ repository: MemoryRepository; orders: DraftDocument; billing: DraftDocument }> {
  const repository = new MemoryRepository();
  await repository.saveProject({ id: 'p_shop', name: 'Shop', createdAt: 1, updatedAt: 1 });
  const orders = documentWith('Orders', 'p_shop');
  const billing = documentWith('Billing');
  await repository.save(orders);
  await repository.save(billing);
  return { repository, orders, billing };
}

describe('buildBackup', () => {
  it('keeps opaque ids in the files without turning them into unsafe or colliding archive paths', async () => {
    const repository = new MemoryRepository();
    await repository.saveProject({ id: 'p_safe', name: 'Preserved grouping', createdAt: 1, updatedAt: 1 });
    const ids = ['../../escape', '..\\escape', '/absolute', '__proto__', 'constructor', 'x\u0000y', 'x/y', 'x~002fy', 'x', 'X', '\ud800', '\ud801', 'a'.repeat(100) + '/'.repeat(20), 'a'.repeat(100) + '\\'.repeat(20), 'a'.repeat(128)];
    for (const id of ids) {
      const document = documentWith(id.length === 128 ? '設'.repeat(60) : 'Same title', 'p_safe');
      await repository.save({ ...document, metadata: { ...document.metadata, id } });
    }
    const { bytes, count } = await buildBackup(repository);
    expect(count).toBe(ids.length);
    const entries = unzipFiles(bytes).filter((entry) => entry.name.endsWith('.draftcanvas'));
    expect(new Set(entries.map((entry) => entry.name.toLowerCase())).size).toBe(ids.length);
    for (const entry of entries) {
      expect(entry.name).not.toMatch(/[/\\]/);
      expect(entry.name).not.toContain('\u0000');
      expect(entry.name).not.toContain('..');
      expect(new TextEncoder().encode(entry.name).length).toBeLessThanOrEqual(255);
    }
    const restored = new MemoryRepository();
    await restoreBackup(restored, bytes);
    expect((await restored.list()).map((entry) => entry.id).sort()).toEqual([...ids].sort());
    expect((await restored.list()).every((entry) => entry.projectId === 'p_safe')).toBe(true);
    const collisions = new MemoryRepository();
    for (const [title, id] of [['a', 'b-c'], ['a-b', 'c']]) {
      const document = documentWith(title!);
      await collisions.save({ ...document, metadata: { ...document.metadata, id: id! } });
    }
    const collided = unzipFiles((await buildBackup(collisions)).bytes).filter((entry) => entry.name.endsWith('.draftcanvas'));
    expect(new Set(collided.map((entry) => entry.name)).size).toBe(2);
  });

  it('reports unreadable diagrams and never records a partial archive as a complete backup', async () => {
    const { repository, orders } = await seeded();
    const load = repository.load.bind(repository);
    vi.spyOn(repository, 'load').mockImplementation((id) => id === orders.metadata.id ? Promise.reject(new Error('Unreadable row')) : load(id));
    const result = await buildBackup(repository);
    expect(result.count).toBe(1);
    expect(result.skipped).toEqual([orders.metadata.id]);
    const previous = '2026-01-01T00:00:00Z';
    writePreference(LAST_BACKUP_PREFERENCE, previous);
    const saver = vi.fn(async () => {});
    const notify = vi.fn();
    setFileSaver(saver);
    try { await backUpLibrary(repository, notify); } finally { setFileSaver(null); }
    expect(saver).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Partial backup'), 'error');
    expect(readPreference(LAST_BACKUP_PREFERENCE)).toBe(previous);
  });

  it('does not silently omit the project manifest after a storage failure', async () => {
    const { repository } = await seeded();
    vi.spyOn(repository, 'listProjects').mockRejectedValue(new Error('Projects unavailable'));
    await expect(buildBackup(repository)).rejects.toThrow('Projects unavailable');
  });

  it('does not mark a cancelled or failed download as a backup', async () => {
    const { repository } = await seeded();
    const previous = '2026-01-01T00:00:00Z';
    writePreference(LAST_BACKUP_PREFERENCE, previous);
    setFileSaver(async () => { throw new DOMException('Cancelled', 'AbortError'); });
    const notify = vi.fn();
    try { await backUpLibrary(repository, notify); } finally { setFileSaver(null); }
    expect(notify).not.toHaveBeenCalled();
    expect(readPreference(LAST_BACKUP_PREFERENCE)).toBe(previous);
  });
  it('writes one .draftcanvas per stored diagram, named by slug and id, plus the project manifest', async () => {
    const { repository, orders, billing } = await seeded();
    const { bytes, count } = await buildBackup(repository);
    expect(count).toBe(2);
    const entries = unzipFiles(bytes);
    const names = entries.map((entry) => entry.name).sort();
    expect(names).toEqual([`billing-${billing.metadata.id}.draftcanvas`, `orders-${orders.metadata.id}.draftcanvas`, 'projects.json'].sort());
    const manifest = JSON.parse(new TextDecoder().decode(entries.find((entry) => entry.name === 'projects.json')!.data));
    expect(manifest.projects.map((p: { id: string }) => p.id)).toEqual(['p_shop']);
    expect(manifest.membership).toEqual({ [orders.metadata.id]: 'p_shop' });
    expect(backupFileName(new Date(2026, 9, 1))).toBe('draft-canvas-backup-2026-10-01.zip');
  });
});

describe('restoreBackup', () => {
  it('puts every diagram and its project back into an empty repository, ids intact', async () => {
    const { repository, orders, billing } = await seeded();
    const { bytes } = await buildBackup(repository);

    const fresh = new MemoryRepository();
    const result = await restoreBackup(fresh, bytes);
    expect(result).toEqual({ restored: 2, renamed: 0, skipped: [] });
    expect((await fresh.list()).map((entry) => entry.id).sort()).toEqual([orders.metadata.id, billing.metadata.id].sort());
    expect((await fresh.listProjects()).map((p) => p.name)).toEqual(['Shop']);
    expect((await fresh.load(orders.metadata.id))!.metadata.projectId).toBe('p_shop');
    expect((await fresh.load(billing.metadata.id))!.metadata.projectId).toBeUndefined();
    expect((await fresh.load(orders.metadata.id))!.nodes[0]!.text).toBe('Orders API');
    expect(describeRestore(result)).toBe('Restored 2 diagrams.');
  });

  it('never overwrites: a taken id arrives as a new copy, and an existing project is left as it is', async () => {
    const { repository, orders } = await seeded();
    const { bytes } = await buildBackup(repository);
    // The Library moved on since the backup.
    await repository.save({ ...orders, nodes: [], edges: [] });
    await repository.saveProject({ id: 'p_shop', name: 'Shop (renamed)', createdAt: 1, updatedAt: 2 });

    const result = await restoreBackup(repository, bytes);
    expect(result).toEqual({ restored: 2, renamed: 2, skipped: [] });
    expect(describeRestore(result)).toBe('Restored 2 diagrams (2 renamed as copies).');
    const list = await repository.list();
    expect(list).toHaveLength(4);
    // The newer local copy is untouched; the restored one sits beside it, in the same project.
    expect((await repository.load(orders.metadata.id))!.nodes).toHaveLength(0);
    const copy = list.find((entry) => entry.title === 'Orders copy' && entry.id !== orders.metadata.id)!;
    expect((await repository.load(copy.id))!.nodes[0]!.text).toBe('Orders API');
    expect(copy.projectId).toBe('p_shop');
    expect((await repository.listProjects())[0]!.name).toBe('Shop (renamed)');
  });

  it('restores a diagram from an older backup that carried a background image, without the image', async () => {
    const repository = new MemoryRepository();
    const document = documentWith('Backdrop');
    await repository.save(document);
    const { bytes } = await buildBackup(repository);
    // An archive as an earlier version wrote it: the image inline in the diagram's settings.
    const files = unzipFiles(bytes);
    const older = zipFiles(files.map((entry) => {
      if (!entry.name.endsWith('.draftcanvas')) return entry;
      const raw = JSON.parse(new TextDecoder().decode(entry.data)) as { settings: Record<string, unknown> };
      raw.settings.background = { enabled: true, fit: 'cover', dim: 0.5, blur: 0, imageId: 'img_1', image: { dataUri: 'data:image/png;base64,iVBORw0KGgo=', width: 4, height: 3 } };
      return { name: entry.name, data: JSON.stringify(raw) };
    }));

    const fresh = new MemoryRepository();
    const result = await restoreBackup(fresh, older);
    expect(result.restored).toBe(1);
    const restored = (await fresh.load(document.metadata.id))!;
    expect(restored.nodes).toHaveLength(document.nodes.length);
    expect(restored.settings).toEqual({ showSequence: true, grid: 'dots' });
  });

  it('skips what it cannot read and says so, and refuses a file that is not a ZIP', async () => {
    const { repository } = await seeded();
    const { bytes } = await buildBackup(repository);
    const fresh = new MemoryRepository();
    const broken = new TextEncoder().encode('not json');
    const { zipFiles } = await import('../src/export/zip');
    const tampered = zipFiles([...unzipFiles(bytes), { name: 'junk-d_x.draftcanvas', data: broken }]);
    const result = await restoreBackup(fresh, tampered);
    expect(result.restored).toBe(2);
    expect(result.skipped).toEqual(['junk-d_x.draftcanvas']);
    expect(describeRestore(result)).toBe('Restored 2 diagrams; 1 file couldn’t be read.');
    await expect(restoreBackup(fresh, broken)).rejects.toThrow(/ZIP/);
  });

  it('restores the entries around one whose image is damaged, and reports nothing lost it', async () => {
    const { zipFiles } = await import('../src/export/zip');
    const { serializeDocument } = await import('../src/export/project');
    const files = ['A', 'B', 'C'].map((title) => {
      const document = documentWith(title);
      const raw = JSON.parse(serializeDocument(document)) as { settings: Record<string, unknown> };
      // As an older backup held it, and hand-damaged: five characters is not valid base64 for `atob`.
      if (title === 'B') raw.settings.background = { enabled: true, image: { dataUri: 'data:image/png;base64,AAAAA', width: 2, height: 2 } };
      return { name: `${title}-${document.metadata.id}.draftcanvas`, data: JSON.stringify(raw) };
    });
    const fresh = new MemoryRepository();
    const result = await restoreBackup(fresh, zipFiles(files));
    expect(result).toEqual({ restored: 3, renamed: 0, skipped: [] });
    expect((await fresh.list()).map((entry) => entry.title).sort()).toEqual(['A', 'B', 'C']);
  });

  it('restores the rest of an archive when one entry is compressed or corrupt, and names it', async () => {
    const { repository } = await seeded();
    const { bytes } = await buildBackup(repository);
    const damaged = new Uint8Array(bytes);
    const view = new DataView(damaged.buffer);
    // The first diagram's central directory entry claims Deflate — what another tool's re-zip writes.
    const centralStart = view.getUint32(damaged.length - 22 + 16, true);
    view.setUint16(centralStart + 10, 8, true);
    const fresh = new MemoryRepository();
    const result = await restoreBackup(fresh, damaged);
    expect(result.restored).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatch(/\.draftcanvas$/);
    expect(describeRestore(result)).toBe('Restored 1 diagram; 1 file couldn’t be read.');
    expect(await fresh.list()).toHaveLength(1);
  });

  it('gives a diagram restored beside its twin a title that tells the two apart', async () => {
    const { repository } = await seeded();
    const { bytes } = await buildBackup(repository);
    const result = await restoreBackup(repository, bytes);
    expect(result.renamed).toBe(2);
    const titles = (await repository.list()).map((entry) => entry.title).sort();
    expect(titles).toEqual(['Billing', 'Billing copy', 'Orders', 'Orders copy']);
  });

  it('reports one failing entry as skipped and still restores the rest', async () => {
    const { repository } = await seeded();
    const { bytes } = await buildBackup(repository);
    const fresh = new MemoryRepository();
    const save = fresh.save.bind(fresh);
    vi.spyOn(fresh, 'save').mockImplementation((document) => document.metadata.title === 'Billing' ? Promise.reject(new Error('Disk full')) : save(document));
    const result = await restoreBackup(fresh, bytes);
    expect(result.restored).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatch(/^billing-.*\.draftcanvas$/);
    expect((await fresh.list()).map((entry) => entry.title)).toEqual(['Orders']);
  });

  it('never overwrites projects it could not list, and still restores the diagrams', async () => {
    const { repository } = await seeded();
    const { bytes } = await buildBackup(repository);
    const target = new MemoryRepository();
    await target.saveProject({ id: 'p_shop', name: 'Shop (renamed)', createdAt: 5, updatedAt: 5 });
    vi.spyOn(target, 'listProjects').mockRejectedValue(new Error('Projects unavailable'));
    const saveProject = vi.spyOn(target, 'saveProject');
    const result = await restoreBackup(target, bytes);
    expect(saveProject).not.toHaveBeenCalled();
    expect(result.restored).toBe(2);
    expect(result.skipped).toEqual(['projects.json']);
    expect((await target.list()).every((entry) => entry.projectId === undefined)).toBe(true);
    vi.restoreAllMocks();
    expect((await target.listProjects())[0]!.name).toBe('Shop (renamed)');
  });

  it('stores only a clean copy of each manifest project, never the archive\'s object as written', async () => {
    const { zipFiles } = await import('../src/export/zip');
    const manifest = {
      projects: [
        { id: 'p_extra', name: '  Sh\u0000op\u0007  ', createdAt: 10, updatedAt: 20, injected: { big: 'x'.repeat(1000) } },
        { id: 'p_long', name: 'n'.repeat(5000), createdAt: Number.NaN, updatedAt: 30 },
        { id: 'p_blank', name: '\u0001\u0002', createdAt: 'yesterday', updatedAt: Infinity },
        { id: '', name: 'No id', createdAt: 1, updatedAt: 1 },
        { name: 'Missing id', createdAt: 1, updatedAt: 1 },
        null,
      ],
      membership: {},
    };
    const bytes = zipFiles([{ name: 'projects.json', data: JSON.stringify(manifest) }]);
    const target = new MemoryRepository();
    const saveProject = vi.spyOn(target, 'saveProject');
    const before = Date.now();
    await restoreBackup(target, bytes);
    const saved = saveProject.mock.calls.map(([project]) => project);
    vi.restoreAllMocks();
    expect(saved.map((p) => p.id)).toEqual(['p_extra', 'p_long', 'p_blank']);
    for (const project of saved) expect(Object.keys(project).sort()).toEqual(['createdAt', 'id', 'name', 'updatedAt']);
    expect(saved[0]).toEqual({ id: 'p_extra', name: 'Shop', createdAt: 10, updatedAt: 20 });
    expect(saved[1]).toMatchObject({ name: 'n'.repeat(200), createdAt: 30, updatedAt: 30 });
    expect(saved[2]!.name).toBe('Untitled project');
    expect(saved[2]!.createdAt).toBeGreaterThanOrEqual(before);
    expect(saved[2]!.updatedAt).toBe(saved[2]!.createdAt);
  });

  it('says in a person’s words that a file is no backup, or a damaged one, and restores nothing', async () => {
    // A text file renamed .zip, and a real backup cut short: the ZIP reader's own words ("the
    // end-of-central-directory record is missing") used to be the toast.
    const { repository } = await seeded();
    const { bytes } = await buildBackup(repository);
    for (const data of [new TextEncoder().encode('just some notes'), bytes.slice(0, bytes.length - 40)]) {
      const fresh = new MemoryRepository();
      const notes: [string, string | undefined][] = [];
      const file = { name: 'my-backup.zip', arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) } as unknown as File;
      expect(await restoreLibrary(fresh, file, (message, tone) => notes.push([message, tone]))).toBeNull();
      expect(notes).toEqual([[NOT_A_BACKUP, 'error']]);
      expect(await fresh.list()).toEqual([]);
    }
  });
});

describe('backupIsStale', () => {
  it('is stale with no record, an unreadable one, or one older than a week', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(backupIsStale(null, now)).toBe(true);
    expect(backupIsStale('yesterday', now)).toBe(true);
    expect(backupIsStale('2026-09-20T12:00:00Z', now)).toBe(true);
    expect(backupIsStale('2026-09-28T12:00:00Z', now)).toBe(false);
  });
});

describe('worthBackingUp', () => {
  it('waits for a few diagrams, or one that has outlived the day it was made', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    const fresh = { createdAt: now - 60_000 };
    expect(worthBackingUp([], now)).toBe(false);
    expect(worthBackingUp([fresh], now)).toBe(false);
    expect(worthBackingUp([fresh, fresh, fresh], now)).toBe(true);
    expect(worthBackingUp([{ createdAt: now - 25 * 60 * 60 * 1000 }], now)).toBe(true);
  });
});
