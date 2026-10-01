import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import type { DraftDocument } from '../src/document/types';
import { unzipFiles } from '../src/export/zip';
import { backupFileName, backupIsStale, buildBackup, describeRestore, restoreBackup } from '../src/storage/backup';
import { MemoryRepository } from '../src/storage/MemoryRepository';

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
    const copy = list.find((entry) => entry.title === 'Orders' && entry.id !== orders.metadata.id)!;
    expect((await repository.load(copy.id))!.nodes[0]!.text).toBe('Orders API');
    expect(copy.projectId).toBe('p_shop');
    expect((await repository.listProjects())[0]!.name).toBe('Shop (renamed)');
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
    expect(describeRestore(result)).toBe("Restored 2 diagrams; 1 file couldn't be read.");
    await expect(restoreBackup(fresh, broken)).rejects.toThrow(/ZIP/);
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
