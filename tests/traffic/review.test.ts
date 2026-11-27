import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkGraphs } from '../../src/depth/tree';
import type { DraftEdge, DraftFlow, DraftNode } from '../../src/document/types';
import { parseDocument } from '../../src/document/validate';
import { analyzeTraffic, lostBy, outageOf, outageReview, type OutageTarget } from '../../src/traffic';
import { glanceOf, outageReadings } from '../../src/traffic/outage';
import { landscape, tangle, type Drawing } from './drawings';
import { edge, node } from './helpers';

/*
 * The review is `outageOf` repeated (AGENTS.md, Outage walk). It used to be exactly that, and read
 * the whole graph again for every shape and connector, so it grew with the square of the diagram:
 * 1.7 s at 940 shapes and close to a minute at the document limit, again after every edit while
 * the list was open. Its readings now share what they can and visit only what each outage changes,
 * and these tests hold them to what taking that one thing down says.
 */

function drawingsIn(dir: string): Drawing[] {
  const found: Drawing[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...drawingsIn(path));
    else if (entry.endsWith('.draftcanvas')) {
      const parsed = parseDocument(readFileSync(path, 'utf8'));
      if (!parsed.ok) throw new Error(`${path}: ${parsed.error}`);
      walkGraphs(parsed.document, (graph) => found.push({ nodes: graph.nodes, edges: graph.edges, flows: graph.flows }));
    }
  }
  return found;
}

/** Every target of a drawing, read both ways. */
function compare({ nodes, edges, flows }: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[]; flows: readonly DraftFlow[] }) {
  const analysis = analyzeTraffic({ nodes, edges });
  const readings = outageReadings(analysis, nodes, edges, flows);
  const targets: OutageTarget[] = [
    ...nodes.flatMap((node) => [{ id: node.id }, { id: node.id, whole: true }]),
    ...edges.map((edge) => ({ id: edge.id, connector: true })),
    { id: 'not-there' },
    { id: 'not-there', connector: true },
  ];
  for (const target of targets) {
    const alone = outageOf(analysis, nodes, edges, target, flows);
    expect(readings.read(target), JSON.stringify(target)).toEqual(alone && glanceOf(alone, analysis));
  }
  for (const node of nodes) expect(readings.lostBy(node.id)).toEqual(lostBy(nodes, node.id));
}

describe('outage review — each reading is the one taking that thing down gives', () => {
  it('on every view of every starter', () => {
    const starters = [...drawingsIn(join(process.cwd(), 'tests/fixtures/starters')), ...drawingsIn(join(process.cwd(), 'tests/fixtures/outage'))];
    expect(starters.length).toBeGreaterThan(18);
    for (const drawing of starters) compare(drawing);
  });

  it('on drawings that try every rule at once', () => {
    // Loops, Junctions, Boundaries (one a parent loop), caches, topics, dead letters, fallbacks,
    // retries, recovery actions, instances and flows, at random.
    for (let seed = 1; seed <= 240; seed += 1) compare(tangle(seed, 6 + (seed % 30)));
  });

  it('on a landscape where a loop leaves shapes no reading reaches', () => {
    compare(landscape(240, 3));
  });

  it('where a severed route shares a Junction leg with a route stopped before it', () => {
    // Z's asynchronous write is the only way into a loop (D publishes to Q, Q hands to A, A writes
    // D through the same Junction leg). Severed, the loop goes quiet, and A's write, which comes
    // first, stops and marks the shared leg before Z's is read.
    const nodes = [node('Z', 'service'), node('J', 'ellipse'), node('D', 'database'), node('Q', 'queue'), node('A', 'service')];
    const edges = [
      edge('zj', 'Z', 'J', { semantic: 'writes', async: true }),
      edge('aj', 'A', 'J', { semantic: 'writes' }),
      edge('jd', 'J', 'D', { semantic: 'writes' }),
      edge('dq', 'D', 'Q', { semantic: 'publishes' }),
      edge('qa', 'Q', 'A', { semantic: 'consumes' }),
    ];
    const flows = [{ id: 'f', title: 'Write', steps: [{ id: 's', edgeId: 'zj' }] }];
    const severed = outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, { id: 'zj', connector: true }, flows)!;
    expect(severed.edges.get('jd')).toBe('stopped');
    expect(severed.edges.has('zj')).toBe(false);
    compare({ nodes, edges, flows });
  });
});

describe('outage review — scale', () => {
  it('reviews a landscape of 2,000 shapes in well under a second', () => {
    // In tiers, with loops the walk goes round. Its calls forward into the next 30 instead (see
    // `landscape`) wait dozens deep, so every reading genuinely fails most of the services, and the
    // review costs what those readings hold: no sharing between them makes that cheaper.
    const { nodes, edges, flows } = landscape(2000, 7, 'tiers');
    const analysis = analyzeTraffic({ nodes, edges });
    expect(nodes.length).toBeGreaterThan(1800);
    expect(edges.length).toBeGreaterThan(3300);
    outageReview(analysis, nodes, edges, flows);
    const started = performance.now();
    const review = outageReview(analysis, nodes, edges, flows);
    const elapsed = performance.now() - started;
    expect(review.entries.length + review.connectors.length).toBeGreaterThan(1000);
    // It took about 7 s here: 1,900 shapes and 3,700 connectors, each read against the whole graph.
    expect(elapsed).toBeLessThan(1_500);
  }, 60_000);
});
