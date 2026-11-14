import { describe, expect, it } from 'vitest';
import { measureContext } from '../../src/agent/place';
import { proportionFindings, resolvedBy, type ProportionFinding } from '../../src/agent/proportion';
import { createEdge, createNode } from '../../src/document/factory';
import type { DraftNode } from '../../src/document/types';
import { naturalArchitectureSize } from '../../src/nodes/describe';
import { fixesNote } from '../../src/ui/Editor/arrangeSummary';

/**
 * Whether a diagram explains itself, beyond clean routes: stacked names, captions with no room,
 * top-heavy boundaries and an overview too small to read (`agent/proportion.ts`).
 */

const LONG_NAME = 'Customer-Facing Public API Gateway and Edge Routing Layer for Web and Mobile';

/** A long name typed into a default-width box: the canvas grows it taller, line by line. */
function typedNarrow(node: DraftNode, text: string): DraftNode {
  const named = { ...node, text, width: 176, height: 68 };
  const size = naturalArchitectureSize(named, measureContext(), { maxWidth: 176, maxHeight: 800, maxNameLines: Number.POSITIVE_INFINITY });
  return { ...named, height: size.height };
}

const kinds = (findings: ProportionFinding[]) => findings.map((f) => `${f.kind}:${f.id}`);

describe('proportion findings', () => {
  it('finds nothing in two shapes a readable distance apart', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'Orders' });
    const b = createNode({ id: 'b', type: 'service', x: 420, y: 0, text: 'Billing' });
    const edge = createEdge({ id: 'e', source: 'a', target: 'b', semantic: 'calls' });
    expect(proportionFindings({ nodes: [a, b], edges: [edge] }, measureContext())).toEqual([]);
  });

  it('reports a name stacked into a column that a wider box holds in fewer lines', () => {
    const stacked = typedNarrow(createNode({ id: 'g', type: 'service', x: 0, y: 0 }), LONG_NAME);
    const short = createNode({ id: 's', type: 'service', x: 400, y: 0, text: 'Orders' });
    expect(kinds(proportionFindings({ nodes: [stacked, short], edges: [] }, measureContext()))).toEqual(['stacked-name:g']);
  });

  it('reports a caption its line has no room for, and a label cut short', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'Orders' });
    // 24 units between the two: no caption fits, and a long label is cut to an ellipsis.
    const b = createNode({ id: 'b', type: 'service', x: a.width + 24, y: 0, text: 'Billing' });
    const ctx = measureContext();
    const caption = createEdge({ id: 'caption', source: 'a', target: 'b', semantic: 'command' });
    expect(kinds(proportionFindings({ nodes: [a, b], edges: [caption] }, ctx))).toEqual(['hidden-caption:caption']);
    const label = createEdge({ id: 'label', source: 'a', target: 'b', label: 'Requests identity verification with document images and a signed consent form for every applicant' });
    expect(kinds(proportionFindings({ nodes: [a, b], edges: [label] }, ctx))).toEqual(['hidden-caption:label']);
  });

  it('reports a boundary whose header band outweighs what it holds', () => {
    const group = { ...createNode({ id: 'grp', type: 'group', x: 0, y: 0, text: 'Orders' }), width: 300, height: 320 };
    const low = { ...createNode({ id: 'm', type: 'service', x: 40, y: 220, text: 'Orders' }), parentId: 'grp' };
    const high = { ...low, y: 60 };
    const ctx = measureContext();
    expect(kinds(proportionFindings({ nodes: [group, low], edges: [] }, ctx))).toEqual(['heavy-header:grp']);
    expect(proportionFindings({ nodes: [group, high], edges: [] }, ctx)).toEqual([]);
  });

  it('reports an overview that draws its smallest text too small on a laptop screen', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'Orders' });
    const far = createNode({ id: 'b', type: 'service', x: 4000, y: 0, text: 'Billing' });
    const edge = createEdge({ id: 'e', source: 'a', target: 'b', semantic: 'calls' });
    const found = proportionFindings({ nodes: [a, far], edges: [edge] }, measureContext());
    expect(found.map((f) => f.kind)).toEqual(['sparse']);
    expect(found[0]!.scale).toBeLessThan(0.5);
  });
});

describe('what an arrangement fixes', () => {
  it('is what was found before and is gone after', () => {
    const before: ProportionFinding[] = [{ kind: 'stacked-name', id: 'a' }, { kind: 'hidden-caption', id: 'e' }];
    expect(resolvedBy(before, [{ kind: 'hidden-caption', id: 'e' }])).toEqual([{ kind: 'stacked-name', id: 'a' }]);
  });

  it('counts a small overview as fixed only when it is readable or clearly larger', () => {
    const before: ProportionFinding[] = [{ kind: 'sparse', id: '', scale: 0.5 }];
    expect(resolvedBy(before, [])).toHaveLength(1);
    expect(resolvedBy(before, [{ kind: 'sparse', id: '', scale: 0.6 }])).toHaveLength(1);
    expect(resolvedBy(before, [{ kind: 'sparse', id: '', scale: 0.52 }])).toEqual([]);
  });

  it('is named in the bar, and not at all when there is nothing', () => {
    expect(fixesNote([{ kind: 'stacked-name', id: 'a' }, { kind: 'stacked-name', id: 'b' }, { kind: 'hidden-caption', id: 'e' }, { kind: 'sparse', id: '' }]))
      .toBe('Fixes 2 stacked names, 1 cut-off caption, a small overview');
    expect(fixesNote([])).toBe('');
    expect(fixesNote(undefined)).toBe('');
  });
});
