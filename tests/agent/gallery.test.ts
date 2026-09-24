import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { applyUpdate } from '../../src/agent/patch';
import { measureContext } from '../../src/agent/place';
import { checkQuality } from '../../src/agent/quality';
import { walkGraphs } from '../../src/depth/tree';
import { viewOf } from '../../src/depth/tree';
import { deserializeDocument } from '../../src/export/project';
import { sequenceSourceFor } from '../../src/export/sequence';
import type { DraftDocument } from '../../src/document/types';
import { GALLERY, type GalleryCase } from '../fixtures/agent/gallery';

function create(request: Record<string, unknown>, id = 'd_gallery00001'): DraftDocument {
  const parsed = deserializeDocument(compose({ requestId: 'g', ...request }, id).text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

/** The whole diagram after the case: created, or created, arranged by hand, then edited. */
export function galleryDocument(entry: GalleryCase): { doc: DraftDocument; before?: DraftDocument; touched?: Set<string> } {
  if (entry.kind === 'create') return { doc: create(entry.request) };
  let base = create(entry.base);
  if (entry.arrange) {
    base = { ...base, nodes: base.nodes.map((node) => (entry.arrange?.[node.id] ? { ...node, ...entry.arrange[node.id] } : node)) };
  }
  const { file, touched } = applyUpdate(base, [], entry.update.ops, undefined);
  return { doc: file, before: base, touched };
}

const geometry = (doc: DraftDocument) => {
  const out: unknown[] = [];
  walkGraphs(doc, (graph) => out.push(graph.nodes.map((n) => [n.id, n.x, n.y, n.width, n.height]), graph.edges.map((e) => [e.id, e.sourceAnchor, e.targetAnchor])));
  return JSON.stringify(out);
};

describe('layout gallery', () => {
  for (const entry of GALLERY) {
    it(`${entry.id}: ${entry.title}`, () => {
      const { doc, before, touched } = galleryDocument(entry);
      const ctx = measureContext();
      // Readable in every view, the drill-downs included.
      walkGraphs(doc, (graph, path) => {
        const view = path.length ? viewOf(doc, path)! : doc;
        const focus = touched && path.length === 0 ? touched : undefined;
        expect(checkQuality(view.nodes, view.edges, ctx, focus).errors, `view ${path.join('/') || 'top'}`).toEqual([]);
        void graph;
      });
      // The same request lays out the same way, to the pixel.
      expect(geometry(galleryDocument(entry).doc)).toBe(geometry(doc));
      if (before) {
        // Nothing that was there moved; the edit's own changes are all that differ.
        for (const node of before.nodes) {
          const now = doc.nodes.find((n) => n.id === node.id);
          // A boundary may grow; an element the edit itself changed may grow into free space.
          if (node.type === 'group' || touched?.has(node.id)) continue;
          expect([now?.x, now?.y], node.id).toEqual([node.x, node.y]);
        }
        expect(doc.flows.map((f) => f.id)).toEqual(expect.arrayContaining(before.flows.map((f) => f.id)));
        expect(doc.actions).toEqual(before.actions);
        // A note is never changed by an edit that didn't name it (an arrange may move it, with its shape).
        for (const note of before.nodes.filter((n) => n.type === 'note')) {
          const now = doc.nodes.find((n) => n.id === note.id);
          expect(touched?.has(note.id) ? { ...now, x: note.x, y: note.y } : now).toEqual(note);
        }
      }
    });
  }

  it('draws connectors straight wherever a straight one is possible', () => {
    // A lone connector between facing sides that still steps sideways is a skew the layout could
    // have avoided. The dense case falls back to a balanced arrangement to fit its captions, and
    // keeps one; everything else has none.
    const jogs = GALLERY.flatMap((entry) => {
      const { doc, touched } = galleryDocument(entry);
      const out: string[] = [];
      walkGraphs(doc, (_graph, path) => {
        const view = path.length ? viewOf(doc, path)! : doc;
        const focus = touched && path.length === 0 ? touched : undefined;
        out.push(...checkQuality(view.nodes, view.edges, measureContext(), focus).warnings.filter((w) => w.kind === 'jog').map((w) => `${entry.id}: ${w.message}`));
      });
      return out;
    });
    expect(jogs.filter((j) => !j.startsWith('10-dense'))).toEqual([]);
    expect(jogs.length).toBeLessThanOrEqual(1);
  });

  it('14: the starter keeps its own flows, and they export as sequence diagrams', () => {
    const entry = GALLERY.find((g) => g.id === '14-starter-flow')!;
    const { doc } = galleryDocument(entry);
    expect(doc.flows.length).toBeGreaterThan(0);
    expect(doc.nodes.find((n) => n.id === 'producer')).toMatchObject({ text: 'Order Service', technology: 'Spring Boot' });
    const mermaid = sequenceSourceFor(doc, 'mermaid');
    expect(mermaid).toContain('sequenceDiagram');
    expect(mermaid).toContain('Order Service');
    expect(sequenceSourceFor(doc, 'plantuml')).toContain('@startuml');
  });

  it('11: the context view keeps its focal system’s containers one level in', () => {
    const { doc } = galleryDocument(GALLERY.find((g) => g.id === '11-c4-context')!);
    expect(doc.level).toBe('context');
    const ibs = doc.nodes.find((n) => n.id === 'ibs')!;
    expect(ibs.inside?.level).toBe('container');
    expect(ibs.inside?.nodes.map((n) => n.id)).toEqual(['spa', 'apiapp']);
    expect(doc.nodes.map((n) => n.id)).not.toContain('spa');
  });
});
