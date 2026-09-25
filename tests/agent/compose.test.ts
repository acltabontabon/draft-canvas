import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { deserializeDocument } from '../../src/export/project';
import { nearestElement } from '../../src/agent/read';

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
          { id: 'assume', text: 'Assumption: one parser per region.', about: 'parser', attach: false },
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
    // The boundary's own note heads it, above what it holds.
    expect(owner.y).toBeLessThan(doc.nodes.find((n) => n.id === 'posting')!.y);
    expect(doc.flows.map((f) => f.title)).toEqual(['Normal processing']);
    expect(out.receipt).toMatchObject({ quality: { errors: 0 } });
  });

  it('lays a note about an element out right beside it, inside its boundary, where a read finds it again', () => {
    const out = compose(
      {
        ...repayment,
        groups: [{ id: 'core', label: 'Posting', kind: 'system' }],
        nodes: repayment.nodes.map((n) => (n.id === 'posting' || n.id === 'ledger' ? { ...n, group: 'core' } : n)),
        notes: [
          { id: 'batch', text: 'Posts in batches of 500; a failed batch is retried whole.', kind: 'decision', about: 'posting', attach: false },
          { id: 'loose', text: 'Owned by the payments guild.' },
        ],
      },
      'd_test00000003',
    );
    const parsed = deserializeDocument(out.text);
    if (!parsed.ok) throw new Error(parsed.error);
    const doc = parsed.document;
    const at = (id: string) => doc.nodes.find((n) => n.id === id)!;
    const note = at('batch');
    const posting = at('posting');
    const core = at('core');
    expect(note.parentId).toBe('core');
    expect(note.x >= core.x && note.y >= core.y && note.x + note.width <= core.x + core.width && note.y + note.height <= core.y + core.height).toBe(true);
    // Just before it across the flow (above, reading right), and nearer to it than to anything else.
    expect(note.y + note.height).toBeLessThanOrEqual(posting.y);
    expect(posting.y - (note.y + note.height)).toBeLessThanOrEqual(40);
    expect(nearestElement(note, doc.nodes)).toBe('posting');
    // Nothing connects to the side the note is on.
    for (const edge of doc.edges) {
      if (edge.source === 'posting') expect(edge.sourceAnchor?.side).not.toBe('top');
      if (edge.target === 'posting') expect(edge.targetAnchor?.side).not.toBe('top');
    }
    // A note about nothing still goes after the diagram.
    expect(at('loose').x).toBeGreaterThan(Math.max(...doc.nodes.filter((n) => n.id !== 'loose').map((n) => n.x + n.width)));
    expect(out.receipt).toMatchObject({ quality: { errors: 0 }, legibility: { crossings: 0 } });
    expect((out.receipt.advisories as string[]).some((a) => a.includes('"loose"') && a.includes('about'))).toBe(true);
  });

  it('attaches a note about an element by default, and puts one beside a full element instead of refusing it', () => {
    const notes = Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, text: `Note ${i}`, about: 'posting' }));
    const out = compose({ ...repayment, notes }, 'd_test00000004');
    const parsed = deserializeDocument(out.text);
    if (!parsed.ok) throw new Error(parsed.error);
    const posting = parsed.document.nodes.find((n) => n.id === 'posting')!;
    // Twelve attach (an element's limit); the thirteenth is laid out beside it, and the receipt says so.
    expect(posting.attachments?.map((a) => a.id)).toEqual(notes.slice(0, 12).map((n) => n.id));
    const last = parsed.document.nodes.find((n) => n.id === 'n12')!;
    expect(last.type).toBe('note');
    expect(nearestElement(last, parsed.document.nodes)).toBe('posting');
    expect((out.receipt.advisories as string[]).some((a) => a.includes('"n12"') && a.includes('beside "posting"'))).toBe(true);
    expect(out.receipt).toMatchObject({ quality: { errors: 0 } });
  });
});
