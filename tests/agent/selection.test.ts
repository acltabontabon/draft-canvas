import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { readSelectionContext } from '../../src/agent/selection';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument } from '../../src/document/types';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_seltest0001').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const base = () =>
  build({
    nodes: [
      { id: 'api', type: 'api', label: 'Orders API' },
      { id: 'db', type: 'database', label: 'Orders DB' },
      { id: 'cache', type: 'redis', label: 'Cache' },
    ],
    relationships: [
      { id: 'ud', from: 'api', to: 'db', label: 'Reads' },
      { id: 'uc', from: 'api', to: 'cache', label: 'Reads' },
    ],
    notes: [{ id: 'n1', text: 'DB is the source of truth.', kind: 'decision', near: 'db' }],
  });

describe('read_selection', () => {
  it('reports nothing selected as an explicit null scope, never a default', () => {
    const file = base();
    const out = readSelectionContext(file, [], { nodes: [], edges: [] }, 'o:1.1', 'd_1');
    expect(out.selection).toBeNull();
    expect(typeof out.message).toBe('string');
  });

  it('tags selected elements apart from bounded 1-hop context neighbors', () => {
    const file = base();
    const out = readSelectionContext(file, [], { nodes: ['api'], edges: [] }, 'o:1.1', 'd_1') as {
      elements: { id: string; role: string }[];
      relationships: { id: string; role: string }[];
    };
    const byId = new Map(out.elements.map((e) => [e.id, e.role]));
    expect(byId.get('api')).toBe('selected');
    expect(byId.get('db')).toBe('context');
    expect(byId.get('cache')).toBe('context');
    const edgeRoles = new Map(out.relationships.map((e) => [e.id, e.role]));
    expect(edgeRoles.get('ud')).toBe('context');
    expect(edgeRoles.get('uc')).toBe('context');
  });

  it('never widens the frozen scope beyond what was actually selected', () => {
    const file = base();
    const out = readSelectionContext(file, [], { nodes: ['api'], edges: [] }, 'o:1.1', 'd_1') as { selection: { nodes: string[] } };
    expect(out.selection.nodes).toEqual(['api']);
  });

  it('includes a note about the selected element, scoped to it', () => {
    const file = base();
    const out = readSelectionContext(file, [], { nodes: ['db'], edges: [] }, 'o:1.1', 'd_1') as { notes?: { id: string; about?: string }[] };
    expect(out.notes?.some((n) => n.id === 'n1' && n.about === 'db')).toBe(true);
  });
});
