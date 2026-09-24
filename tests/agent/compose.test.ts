import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { deserializeDocument } from '../../src/export/project';

const repayment = {
  requestId: 'r1',
  title: 'Repayment processing',
  nodes: [
    { id: 'parser', type: 'service', label: 'Batch Parser' },
    { id: 'events', type: 'topic', label: 'Repayment Events' },
    { id: 'queue', type: 'queue', label: 'Posting Queue' },
    { id: 'posting', type: 'service', label: 'Repayment Posting' },
    { id: 'ledger', type: 'database', label: 'Ledger' },
  ],
  relationships: [
    { id: 'r1', from: 'parser', to: 'events', label: 'Publishes' },
    { id: 'r2', from: 'events', to: 'queue', label: 'Delivers' },
    { id: 'r3', from: 'queue', to: 'posting', label: 'Consumed by' },
    { id: 'r4', from: 'posting', to: 'ledger', label: 'Posts repayment' },
  ],
  layout: { direction: 'right', spacing: 'comfortable' },
};

describe('compose', () => {
  it('lays out a simple chain left to right and passes its own gate', () => {
    const out = compose(repayment, 'd_test00000001');
    const parsed = deserializeDocument(out.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const doc = parsed.document;
    expect(doc.metadata.id).toBe('d_test00000001');
    const xs = ['parser', 'events', 'queue', 'posting', 'ledger'].map((id) => doc.nodes.find((n) => n.id === id)!.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(out.receipt).toMatchObject({ created: { elements: 5, relationships: 4 }, quality: { errors: 0 } });
  });

  it('creates notes and a main flow in the same request: attached, inside a boundary, or beside', () => {
    const out = compose(
      {
        ...repayment,
        groups: [{ id: 'core', label: 'Posting', kind: 'system' }],
        nodes: repayment.nodes.map((n) => (n.id === 'posting' || n.id === 'ledger' ? { ...n, group: 'core' } : n)),
        notes: [
          { id: 'retry', text: 'Retries 5 times with backoff,\nthen parks in the DLQ.', kind: 'warning', about: 'r3' },
          { id: 'owner', text: 'Owned by the ledger team.', about: 'core' },
          { id: 'assume', text: 'Assumption: one parser per region.', about: 'parser' },
          { id: 'why', text: 'Posts in batches of 500.', about: 'posting', attach: true },
        ],
        flows: [{ id: 'main', title: 'Normal processing', steps: ['r1', 'r2', 'r3', 'r4'] }],
        layout: { primaryFlow: 'main' },
      },
      'd_test00000002',
    );
    const parsed = deserializeDocument(out.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const doc = parsed.document;
    expect(doc.edges.find((e) => e.id === 'r3')!.attachments?.[0]).toMatchObject({ id: 'retry', noteKind: 'warning' });
    expect(doc.nodes.find((n) => n.id === 'posting')!.attachments?.[0]).toMatchObject({ id: 'why' });
    const owner = doc.nodes.find((n) => n.id === 'owner')!;
    const core = doc.nodes.find((n) => n.id === 'core')!;
    expect(owner.parentId).toBe('core');
    expect(owner.x >= core.x && owner.y >= core.y && owner.x + owner.width <= core.x + core.width && owner.y + owner.height <= core.y + core.height).toBe(true);
    expect(doc.nodes.find((n) => n.id === 'assume')!.parentId).toBeUndefined();
    expect(doc.flows.map((f) => f.title)).toEqual(['Normal processing']);
    expect(out.receipt).toMatchObject({ quality: { errors: 0 } });
  });
});
