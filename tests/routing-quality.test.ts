import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routingCorpus } from './fixtures/routing/corpus';
import { drawnConnectors } from './fixtures/routing/drawn';
import { measure, noWorse, type Quality } from './fixtures/routing/measure';

/**
 * Connector quality across the routing corpus, held to a committed baseline.
 *
 * Hard rules never break. Quality is compared per view, most important tier first (obstruction,
 * accidental overlap, crossings, length and bends): a view may get worse at a lower tier only where
 * it got better at a higher one. Every drawn line is also kept as a golden snapshot, so a routing
 * change shows exactly which lines moved.
 *
 * After an intended change: `ROUTING_BASELINE=update npx vitest run tests/routing-quality.test.ts`,
 * then review the diff of both files before committing them.
 */

const BASELINE = resolve(process.cwd(), 'tests/fixtures/routing/quality-baseline.json');
const GOLDEN = resolve(process.cwd(), 'tests/fixtures/routing/golden-routes.json');
const UPDATE = process.env.ROUTING_BASELINE === 'update';

type Baseline = Record<string, Quality['tiers'] & { violations: Quality['violations']; unresolved: Quality['unresolved'] }>;
type Golden = Record<string, Record<string, [string, string | null]>>;

const read = <T>(url: string): T | null => (existsSync(url) ? (JSON.parse(readFileSync(url, 'utf8')) as T) : null);
const sorted = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));

describe('routing quality', { timeout: 60_000 }, () => {
  const corpus = routingCorpus();
  const results = new Map(corpus.map((fixture) => [fixture.id, measure(fixture.nodes, fixture.edges)]));
  const golden: Golden = Object.fromEntries(corpus.map((fixture) => [
    fixture.id,
    Object.fromEntries(drawnConnectors(fixture.nodes, fixture.edges).map((c) => [c.edge.id, [c.request.d, c.response?.d ?? null]])),
  ]));

  if (UPDATE) {
    const baseline: Baseline = {};
    for (const [id, q] of results) baseline[id] = { ...q.tiers, violations: q.violations, unresolved: q.unresolved };
    writeFileSync(BASELINE, `${JSON.stringify(sorted(baseline), null, 2)}\n`);
    writeFileSync(GOLDEN, `${JSON.stringify(sorted(golden), null, 1)}\n`);
  }

  const baseline = read<Baseline>(BASELINE) ?? {};
  const goldenBase = read<Golden>(GOLDEN) ?? {};

  it('measures every fixture in the corpus', () => {
    expect(corpus.length).toBeGreaterThan(40);
    expect(Object.keys(baseline).sort()).toEqual([...results.keys()].sort());
  });

  for (const fixture of corpus) {
    it(fixture.id, () => {
      const q = results.get(fixture.id)!;
      const base = baseline[fixture.id];
      expect(base, 'baseline entry').toBeDefined();
      // Hard rules: never more than the baseline, which is zero for every rule but pins until the
      // pin contract makes that zero too.
      expect(q.violations.endpoint, 'end points off their side').toBeLessThanOrEqual(base!.violations.endpoint);
      expect(q.violations.continuity, 'broken lines').toBe(0);
      expect(q.violations.bends, 'hand bends lost').toBe(0);
      expect(q.violations.pins, `pins moved: ${q.detail.pinsMoved.join(', ')}`).toBeLessThanOrEqual(base!.violations.pins);
      expect(noWorse(q.tiers, base!), `tiers ${JSON.stringify(q.tiers)} vs ${JSON.stringify(base)}; through: ${q.detail.through.join(', ')}`).toBe(true);
    });
  }

  it('spreading ends that share a side at least halves their accidental overlap', () => {
    for (const fixture of corpus.filter((f) => f.id.startsWith('case/side-share'))) {
      const before = measure(fixture.nodes, fixture.edges, { spread: false }).tiers;
      const after = results.get(fixture.id)!.tiers;
      expect(before.overlap, fixture.id).toBeGreaterThan(0);
      expect(after.overlap, fixture.id).toBeLessThanOrEqual(before.overlap / 2);
      expect(after.obstruction, fixture.id).toBeLessThanOrEqual(before.obstruction);
    }
  });

  it('separates connectors sharing a corridor, without adding a crossing', () => {
    for (const id of ['case/shared-corridor', 'case/corridor-70', 'case/side-share']) {
      const q = results.get(id)!;
      expect(q.tiers.overlap, id).toBe(0);
      expect(q.tiers.crossings, id).toBeLessThanOrEqual(baseline[id]!.crossings);
    }
  });

  it('draws every line exactly as the golden snapshot', () => {
    const changed: string[] = [];
    for (const [id, lines] of Object.entries(golden)) {
      for (const [edgeId, d] of Object.entries(lines)) {
        const before = goldenBase[id]?.[edgeId];
        if (!before || before[0] !== d[0] || before[1] !== d[1]) changed.push(`${id}:${edgeId}`);
      }
    }
    expect(changed).toEqual([]);
  });
});
