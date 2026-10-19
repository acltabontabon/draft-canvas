import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPreviews, holdPreview, readPreview } from '../../src/desktop/agentPreviews';
import { createDocument } from '../../src/document/factory';
import { runJob } from '../../src/agent/jobs';

afterEach(() => { clearPreviews(); vi.restoreAllMocks(); });

const candidate = () => {
  const baseFile = createDocument();
  const result = runJob({ kind: 'update', file: baseFile, path: [], ops: [{ op: 'add', nodes: [{ id: 'api', type: 'api', label: 'API' }] }], layout: undefined }, Infinity);
  if (result.kind !== 'update') throw new Error('Expected update');
  return { baseFile, result, path: [], diagramId: 'd_one', session: 's_one', revision: 'f:one' };
};

describe('ephemeral MCP candidates', () => {
  it('expires candidates and evicts the oldest once capacity is reached', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const held = candidate();
    const first = holdPreview(held);
    for (let i = 0; i < 4; i += 1) holdPreview(held);
    expect(() => readPreview(first, 'd_one', 's_one', 'f:one')).toThrow(/expired/);
    const current = holdPreview(held);
    expect(readPreview(current, 'd_one', 's_one', 'f:one').result).toBe(held.result);
    now += 10 * 60_000;
    expect(() => readPreview(current, 'd_one', 's_one', 'f:one')).toThrow(/expired/);
  });

  it('binds candidates to session, diagram, view and full base content', () => {
    const held = candidate();
    const id = holdPreview(held);
    expect(() => readPreview(id, 'd_two', 's_one', 'f:one')).toThrow();
    expect(() => readPreview(id, 'd_one', 's_two', 'f:one')).toThrow();
    expect(() => readPreview(id, 'd_one', 's_one', 'f:one', ['api'])).toThrow(/changed/);
    const changed = { ...held.baseFile, metadata: { ...held.baseFile.metadata, title: 'Human edit' } };
    expect(() => readPreview(id, 'd_one', 's_one', 'f:one', [], changed)).toThrow(/changed/);
    clearPreviews();
    expect(() => readPreview(id, 'd_one', 's_one', 'f:one')).toThrow();
  });

  it('keeps a candidate usable when the person only pans or zooms', () => {
    const held = candidate();
    const id = holdPreview(held);
    const panned = { ...held.baseFile, viewport: { x: 340, y: -120, zoom: 0.6 } };
    expect(readPreview(id, 'd_one', 's_one', 'f:one', [], panned).result).toBe(held.result);
  });
});
