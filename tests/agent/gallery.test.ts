import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { applyUpdate } from '../../src/agent/patch';
import { measureContext } from '../../src/agent/place';
import { checkQuality } from '../../src/agent/quality';
import { bendsOf, drawnRoute } from '../../src/agent/route';
import { walkGraphs } from '../../src/depth/tree';
import { viewOf } from '../../src/depth/tree';
import { deserializeDocument } from '../../src/export/project';
import { sequenceSourceFor } from '../../src/export/sequence';
import type { DraftDocument } from '../../src/document/types';
import { GALLERY, type GalleryCase } from '../fixtures/agent/gallery';
import { legibilityOf } from '../../src/agent/legibility';
import { nearestElement } from '../../src/agent/read';

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
    // keeps one; the card-provisioning case's two returns into the system (a reviewer's decision,
    // the provisioning outcome under the main path) step on their way, and are held to it below.
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
    expect(jogs.filter((j) => !j.startsWith('10-dense') && !j.startsWith('21-card'))).toEqual([]);
    expect(jogs.filter((j) => j.startsWith('10-dense')).length).toBeLessThanOrEqual(1);
    expect(jogs.filter((j) => j.startsWith('21-card')).length).toBeLessThanOrEqual(2);
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

  it('19: the loan-application reference case comes out peer-uniform and readable — the regression it was built for', () => {
    const { doc } = galleryDocument(GALLERY.find((g) => g.id === '19-loan-application-context')!);
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const size = (id: string) => {
      const n = byId.get(id)!;
      return `${n.width}x${n.height}`;
    };
    // The two actors read as a row: same box, however different their descriptions' lengths.
    expect(size('applicant')).toBe(size('officer'));
    // The four external systems read as a row too, none of them enlarged by another's description.
    expect(size('bureau')).toBe(size('kyc'));
    expect(size('kyc')).toBe(size('core'));
    expect(size('core')).toBe(size('notify'));
    // Nothing is left unnecessarily bent — the loan officer's edge no longer loops around the focal
    // system, and no connector here needs more than a couple of corners to reach its target.
    for (const edge of doc.edges) {
      const drawn = drawnRoute(edge, doc.nodes, doc.edges);
      expect(drawn, edge.id).not.toBeNull();
      expect(bendsOf(drawn!.points), edge.id).toBeLessThanOrEqual(2);
    }
    expect(checkQuality(doc.nodes, doc.edges, measureContext())).toEqual({ errors: [], warnings: [] });
  });

  it('21: the reported container view reads — providers beside their callers, notes beside their subjects', () => {
    const entry = GALLERY.find((g) => g.id === '21-card-provisioning')!;
    const { doc } = galleryDocument(entry);
    const at = (id: string) => doc.nodes.find((n) => n.id === id)!;
    const notes = new Map([
      ['n-retry', 'check'],
      ['n-notify', 'notify'],
    ]);
    const legibility = legibilityOf(doc.nodes, doc.edges, notes);
    // It used to have five crossings, two lines through unrelated boundaries and a stranded note.
    expect(legibility.farNotes).toEqual([]);
    expect(legibility.detours).toEqual([]);
    expect(legibility.crossings).toBeLessThanOrEqual(3);
    expect(legibility.throughBoundaries.length).toBeLessThanOrEqual(1);
    // Each provider is level with the check that calls it: a straight line out of the system.
    for (const id of ['r11', 'r12', 'r13']) {
      const points = drawnRoute(doc.edges.find((e) => e.id === id)!, doc.nodes, doc.edges)!.points;
      expect(new Set(points.map((p) => Math.round(p.y))).size, id).toBe(1);
    }
    // The notes sit inside the boundary of what they describe; the decision heads its domain.
    expect(at('n-retry').parentId).toBe('svc');
    expect(at('n-notify').parentId).toBe('platform');
    expect(nearestElement(at('n-retry'), doc.nodes)).toBe('check');
    expect(nearestElement(at('n-notify'), doc.nodes)).toBe('notify');
    expect(at('n-decision').y).toBeLessThan(Math.min(...doc.nodes.filter((n) => n.parentId === 'svc' && n.type !== 'note').map((n) => n.y)));
    // And the receipt tells the agent what else would help: this domain belongs a level down.
    const out = compose({ requestId: 'g', ...(entry as { request: Record<string, unknown> }).request }, 'd_gallery00001');
    expect(out.receipt.legibility).toMatchObject({ crossings: legibility.crossings });
    expect((out.receipt.advisories as string[])[0]).toContain('"svc"');
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
