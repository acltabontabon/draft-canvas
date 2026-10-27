import { describe, expect, it } from 'vitest';
import { capabilities } from '../../src/agent/capabilities';
import { compose } from '../../src/agent/compile';
import { readDiagram } from '../../src/agent/read';
import { readSelectionContext } from '../../src/agent/selection';
import type { DraftDocument } from '../../src/document/types';
import { deserializeDocument } from '../../src/export/project';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_compactout0').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const file = () =>
  build({
    level: 'container',
    groups: [{ id: 'sys', label: 'Orders', kind: 'system' }],
    nodes: [
      { id: 'api', type: 'api', label: 'Orders API', group: 'sys' },
      { id: 'db', type: 'database', label: 'Orders DB', group: 'sys' },
    ],
    relationships: [{ id: 'd', from: 'api', to: 'db' }],
    notes: [
      { id: 'why', text: 'Writes are idempotent by client key.', about: 'd' },
      { id: 'sql', kind: 'code', code: 'SELECT 1;', language: 'sql', about: 'd' },
    ],
  });

describe('compact agent output', () => {
  it('answers get_capabilities without topics with an index and the common words, not every topic', () => {
    const index = capabilities({});
    expect(Object.keys(index.topics as object)).toEqual(['types', 'relationships', 'c4', 'flows', 'notes', 'starters', 'limits', 'layout', 'readability']);
    expect(index.types).toContain('api');
    expect(index.noteKinds).toEqual(['note', 'question', 'warning', 'decision', 'code', 'label']);
    expect(index.readability).toBeUndefined();
    expect(JSON.stringify(index).length).toBeLessThan(2_000);
    // Each topic in full on request, unchanged.
    expect(capabilities({ topics: ['readability'] }).readability).toBeDefined();
  });

  it('keeps the Markdown catalogue out of the flows topic', () => {
    expect(capabilities({ topics: ['flows'] }).notes).toBeUndefined();
    expect(capabilities({ topics: ['notes'] }).notes).toBeDefined();
  });

  it('answers a starter and topics asked for together', () => {
    const both = capabilities({ topics: ['limits'], starter: 'monolith' });
    expect(both.starter).toMatchObject({ id: 'monolith' });
    expect(both.limits).toBeDefined();
  });

  it('reads C4 role and scope without per-element provenance, and only the role\'s reason when it is open', () => {
    const read = readDiagram(file(), {}, 'r', 'd') as { elements: { id: string; c4?: Record<string, unknown> }[]; view: Record<string, unknown> };
    expect(read.elements.find((e) => e.id === 'api')?.c4).toEqual({ role: 'container', scope: 'internal' });
    expect(JSON.stringify(read)).not.toContain('"derived"');
    expect(read.view.insideViews).toBeUndefined();
    const open = readDiagram({ ...file(), level: 'component' }, {}, 'r', 'd') as typeof read;
    expect(open.elements.find((e) => e.id === 'api')?.c4).toEqual({ role: 'unspecified', scope: 'internal', basis: "service at component level: container or component can't be told apart" });
  });

  it('rounds display geometry and leaves out empty pins, never touching the document', () => {
    const doc = file();
    const shifted = { ...doc, nodes: doc.nodes.map((n) => (n.id === 'api' ? { ...n, y: n.y + 0.123456 } : n)) };
    const read = readDiagram(shifted, { include: ['geometry'] }, 'r', 'd') as { elements: { id: string; geometry: { y: number } }[]; relationships: { geometry: Record<string, unknown> }[] };
    const api = shifted.nodes.find((n) => n.id === 'api')!;
    expect(read.elements.find((e) => e.id === 'api')!.geometry.y).toBe(Math.round(api.y * 100) / 100);
    expect(api.y % 1).not.toBe(0);
    for (const edge of read.relationships) if ('pins' in edge.geometry) expect(Object.keys(edge.geometry.pins as object).length).toBeGreaterThan(0);
  });

  it('sends a selected relationship\'s notes and snippets once', () => {
    const out = readSelectionContext(file(), [], { nodes: [], edges: ['d'] }, 'r', 'd') as { relationships: Record<string, unknown>[]; notes: { id: string }[]; snippets: { id: string }[] };
    const text = JSON.stringify(out);
    expect(text.split('Writes are idempotent').length - 1).toBe(1);
    expect(text.split('SELECT 1;').length - 1).toBe(1);
    expect(out.relationships[0]).toMatchObject({ id: 'd', attachmentCount: 2 });
    expect(out.notes.map((n) => n.id)).toEqual(['why']);
    expect(out.snippets.map((n) => n.id)).toEqual(['sql']);
  });
});
