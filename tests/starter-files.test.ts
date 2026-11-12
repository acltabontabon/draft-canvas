import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { categoryOf } from '../src/document/connectorSemantics';
import { relationshipCaptionLabel } from '../src/document/edgeSemantics';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { labelGroupPlan } from '../src/edges/labelGroups';
import { layoutConnectorCaption, layoutEdgeLabel } from '../src/edges/labelLayout';
import { straightenPositions } from '../src/edges/straighten';
import { deserializeDocument } from '../src/export/project';

/**
 * The quality gate for starter gallery files: the vendored snapshot in `tests/fixtures/starters/`
 * by default, or any checkout of github.com/acltabontabon/draft-canvas-starters —
 *
 *   STARTERS_DIR=../draft-canvas-starters npx vitest run tests/starter-files.test.ts
 *
 * which is how that repository's CI checks a change against the app that will open it. A starter is
 * an ordinary diagram, so the bar is what a person would notice: it opens without repairs, nothing
 * overlaps, no connector has a kink Straighten would remove, every caption is whole and every flow
 * step names a connector.
 */

const ROOT = resolve(process.env.STARTERS_DIR ?? join(__dirname, 'fixtures', 'starters'));
const FOLDERS: Record<string, string> = { architecture: 'architectures', data: 'data', pattern: 'patterns', example: 'examples' };

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.draftcanvas')) found.push(path);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * The test measurer is a fixed-width approximation, and real fonts run wider: a caption that only
 * just fits here is cut short in the app ("publishes…"). Starters keep this much room spare.
 */
const CAPTION_SLACK = 1.15;

function fitsWhole(layout: { truncated: boolean; width: number }, room: number | undefined): boolean {
  return !layout.truncated && (room === undefined || layout.width * CAPTION_SLACK <= room);
}

const STARTERS_ROOT = join(ROOT, 'starters');
const FILES = filesUnder(STARTERS_ROOT);

function overlaps(a: DraftNode, b: DraftNode): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function ancestorIds(node: DraftNode, byId: ReadonlyMap<string, DraftNode>): Set<string> {
  const ids = new Set<string>();
  let parent = node.parentId ? byId.get(node.parentId) : undefined;
  while (parent && !ids.has(parent.id)) {
    ids.add(parent.id);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return ids;
}

describe('starter gallery files', () => {
  it('finds starters to check', () => {
    expect(FILES.length, STARTERS_ROOT).toBeGreaterThan(0);
  });

  describe.each(FILES.map((file) => [basename(file, '.draftcanvas'), file] as const))('%s', (id, file) => {
    const meta = JSON.parse(readFileSync(join(dirname(file), 'starter.json'), 'utf8')) as Record<string, unknown>;
    const parsed = deserializeDocument(readFileSync(file, 'utf8'));
    const doc = (parsed.ok ? parsed.document : null) as DraftDocument;

    it('is described by its folder', () => {
      expect(meta.id).toBe(id);
      expect(basename(dirname(file))).toBe(id);
      expect(basename(dirname(dirname(file)))).toBe(FOLDERS[meta.category as string]);
      expect(typeof meta.name === 'string' && meta.name.length > 0).toBe(true);
      expect(typeof meta.summary === 'string' && meta.summary.length > 0).toBe(true);
    });

    it('opens without repairs', () => {
      expect(parsed.ok && parsed.repairs, parsed.ok ? '' : parsed.error).toEqual([]);
    });

    it('has no overlapping shapes', () => {
      const byId = new Map(doc.nodes.map((node) => [node.id, node]));
      const shapes = doc.nodes.filter((node) => node.type !== 'group');
      for (const [index, a] of shapes.entries()) {
        for (const b of shapes.slice(index + 1)) {
          if (ancestorIds(a, byId).has(b.id) || ancestorIds(b, byId).has(a.id)) continue;
          expect(overlaps(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
        }
      }
    });

    it('has no connector kink Straighten would remove', () => {
      expect([...straightenPositions(doc).keys()]).toEqual([]);
    });

    it('shows every caption whole', () => {
      const byId = new Map(doc.nodes.map((node) => [node.id, node]));
      const groups = labelGroupPlan(doc.nodes, doc.edges);
      for (const edge of doc.edges) {
        // A fan's members share one caption, placed on the trunk, not each in its own room.
        if (groups.groupFor(edge.id)) continue;
        // No room at all: a bundled member whose caption is drawn on the shared trunk.
        if (connectorRoutes(edge, doc, 'canvas', byId)?.request.labelRoom === 0) continue;
        const route = connectorRoutes(edge, doc, 'canvas', byId)?.request;
        expect(route, edge.id).toBeTruthy();
        if (!route) continue;
        const label = edge.label?.trim();
        if (label) {
          expect(fitsWhole(layoutEdgeLabel(label, undefined, route.labelRoom), route.labelRoom), `${edge.id}: ${label}`).toBe(true);
          continue;
        }
        if (!edge.semantic) continue;
        const source = byId.get(edge.source)!;
        const target = byId.get(edge.target)!;
        const caption = relationshipCaptionLabel(edge.semantic, { hasResponse: edge.hasResponse, source: categoryOf(source), target: categoryOf(target) });
        if (!caption) continue;
        expect(fitsWhole(layoutConnectorCaption(caption, undefined, route.labelRoom), route.labelRoom), `${edge.id}: ${caption}`).toBe(true);
      }
    });

    it('has flows whose steps all name a connector', () => {
      const edgeIds = new Set(doc.edges.map((edge) => edge.id));
      expect(doc.flows.length).toBeGreaterThan(0);
      for (const flow of doc.flows) {
        expect(flow.steps.length, flow.title).toBeGreaterThan(0);
        for (const step of flow.steps) expect(!!step.edgeId && edgeIds.has(step.edgeId), `${flow.title}: ${step.edgeId}`).toBe(true);
      }
    });
  });
});
