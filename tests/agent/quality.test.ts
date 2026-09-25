/**
 * `checkQuality`/`isBetterReport` (`agent/quality.ts`): warnings are detected, weighed correctly
 * against errors when candidates are compared, and actually drive the repair ladder that picks
 * among them.
 */
import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { measureContext } from '../../src/agent/place';
import { checkFit, checkQuality, isBetterCandidate, isBetterReport, isClean, isCleanCandidate, type QualityReport } from '../../src/agent/quality';
import { deserializeDocument } from '../../src/export/project';
import type { DraftNode } from '../../src/document/types';

const report = (errors: number, warnings: number): QualityReport => ({
  errors: Array.from({ length: errors }, (_, i) => ({ kind: 'overlap' as const, ids: [`e${i}`], message: '' })),
  warnings: Array.from({ length: warnings }, (_, i) => ({ kind: 'jog' as const, ids: [`w${i}`], message: '' })),
});

describe('isBetterReport', () => {
  it('lets an error-free candidate win over one with fewer errors but far more warnings', () => {
    // A plain weighted sum could get this backwards: 25 jogs (weight 1 each = 25) would outweigh
    // one overlap (weight 100) numerically, but an error must never lose to any number of warnings.
    const oneError25Warnings = report(1, 25);
    const noErrorsManyWarnings = report(0, 25);
    expect(isBetterReport(noErrorsManyWarnings, oneError25Warnings)).toBe(true);
    expect(isBetterReport(oneError25Warnings, noErrorsManyWarnings)).toBe(false);
  });

  it('only compares warnings as a tiebreaker once error counts are equal', () => {
    expect(isBetterReport(report(0, 1), report(0, 3))).toBe(true);
    expect(isBetterReport(report(0, 3), report(0, 1))).toBe(false);
    expect(isBetterReport(report(2, 0), report(2, 5))).toBe(true);
  });

  it('treats an equal report as no improvement, so a tie keeps the earlier candidate', () => {
    expect(isBetterReport(report(1, 1), report(1, 1))).toBe(false);
  });
});

describe('isClean', () => {
  it('is true only with no errors and no warnings left', () => {
    expect(isClean(report(0, 0))).toBe(true);
    expect(isClean(report(0, 1))).toBe(false);
    expect(isClean(report(1, 0))).toBe(false);
  });
});

describe('a connector reported as a jog', () => {
  it('is flagged by checkQuality when its two ends face each other but are not level', () => {
    // Two shapes, right-to-left facing sides, deliberately off-level by more than a pixel — the
    // sole connector on both sides, so nothing about a shared handle explains the offset away.
    const nodes: DraftNode[] = [
      { id: 'a', type: 'service', x: 0, y: 0, width: 140, height: 60, z: 0 },
      { id: 'b', type: 'service', x: 300, y: 40, width: 140, height: 60, z: 0 },
    ];
    const edges = [
      { id: 'e', source: 'a', target: 'b', directed: true, routing: 'smoothstep' as const, sourceAnchor: { side: 'right' as const, offset: 0.5 }, targetAnchor: { side: 'left' as const, offset: 0.5 } },
    ];
    const found = checkQuality(nodes, edges, measureContext());
    expect(found.errors).toEqual([]);
    expect(found.warnings).toEqual([expect.objectContaining({ kind: 'jog', ids: ['e'] })]);
  });
});

describe('the create_diagram repair ladder', () => {
  it('moves past a warning-bearing first attempt to a clean later one, and reports it honestly', () => {
    // Explicitly requested spacing that is known to leave one connector jogged (a queue's sole
    // connector to its dead-letter queue, not quite level at "spacious" spacing) — with peer-size
    // normalization off, isolating this from Phase 1's own effect on the same fixture. Before the
    // fix, `compose()`'s repair loop scored candidates on errors alone and broke as soon as the
    // first (spacious) attempt had zero of those, keeping the jog; it now keeps looking until a
    // candidate has no warnings left either, and lands on `comfortable`.
    const request = {
      title: 'Repayment events fan-out',
      layout: { spacing: 'spacious', normalizePeerSizes: false },
      nodes: [
        { id: 'parser', type: 'service', label: 'Batch Parser', technology: 'Spring Batch' },
        { id: 'sns', type: 'topic', label: 'Repayment Events', technology: 'Amazon SNS' },
        { id: 'q1', type: 'queue', label: 'Posting Queue', technology: 'SQS' },
        { id: 'q2', type: 'queue', label: 'Audit Queue', technology: 'SQS' },
        { id: 'q3', type: 'queue', label: 'Notification Queue', technology: 'SQS' },
        { id: 'posting', type: 'worker', label: 'Repayment Posting' },
        { id: 'audit', type: 'worker', label: 'Audit Writer' },
        { id: 'notify', type: 'worker', label: 'Borrower Notifier' },
        { id: 'dlq', type: 'dead-letter-queue', label: 'Posting DLQ' },
      ],
      relationships: [
        { id: 'p', from: 'parser', to: 'sns', label: 'Publishes' },
        { id: 's1', from: 'sns', to: 'q1' },
        { id: 's2', from: 'sns', to: 'q2' },
        { id: 's3', from: 'sns', to: 'q3' },
        { id: 'c1', from: 'q1', to: 'posting' },
        { id: 'c2', from: 'q2', to: 'audit' },
        { id: 'c3', from: 'q3', to: 'notify' },
        { id: 'd1', from: 'q1', to: 'dlq' },
      ],
    };
    const composed = compose(request, 'd_repairladdr');
    const parsed = deserializeDocument(composed.text);
    if (!parsed.ok) throw new Error(parsed.error);
    const found = checkQuality(parsed.document.nodes, parsed.document.edges, measureContext());
    expect(found.warnings).toEqual([]);
    expect(found.errors).toEqual([]);
    expect(composed.receipt.layout).toEqual({ direction: 'right', spacing: 'comfortable' });
    expect(composed.receipt.quality).toMatchObject({ scope: 'whole-diagram', errors: 0, warnings: 0 });
  });

  it("prefers the direction that fits the requested viewport when the caller's own choice doesn't", () => {
    // A long sequential chain: laid out reading right, it comes out very wide and short — unreadable
    // at a tall, narrow viewport no matter how it's tidied — but reading down it comes out narrow and
    // tall, which does fit. Direction isn't pinned, so the ladder can try both.
    const chain = {
      title: 'Chain',
      nodes: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, type: 'service', label: `Service ${i}` })),
      relationships: Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}`, label: 'calls' })),
      layout: { viewport: [400, 1400] as [number, number] },
    };
    const composed = compose(chain, 'd_viewportfit');
    expect(composed.receipt.layout).toMatchObject({ direction: 'down' });
    expect((composed.receipt as { fit?: { readable: boolean } }).fit?.readable).toBe(true);
  });

  it('refuses, with an actionable diagnostic, when no candidate is readable at the given viewport', () => {
    const chain = {
      title: 'Chain',
      nodes: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, type: 'service', label: `Service ${i}` })),
      relationships: Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}`, label: 'calls' })),
      layout: { viewport: [80, 80] as [number, number] },
    };
    expect(() => compose(chain, 'd_viewportfail')).toThrow(/too small to read/);
    // The same request is accepted, and says so honestly, once the caller opts in to a degraded fit.
    const degraded = compose({ ...chain, layout: { ...chain.layout, allowDegraded: true } }, 'd_viewportok');
    expect(degraded.receipt).toMatchObject({ degraded: true, fit: { readable: false } });
  });
});

describe('checkFit', () => {
  it('never scales a diagram up past its own size to fill a larger frame', () => {
    expect(checkFit({ width: 100, height: 50 }, 10, [1000, 1000]).scale).toBe(1);
  });

  it('flags text below the readable floor once the frame forces it small enough', () => {
    const roomy = checkFit({ width: 200, height: 100 }, 10, [200, 100]);
    expect(roomy.readable).toBe(true);
    const cramped = checkFit({ width: 2000, height: 1000 }, 10, [200, 100]);
    expect(cramped.effectiveFontPx).toBeCloseTo(1, 5);
    expect(cramped.readable).toBe(false);
  });
});

describe('isBetterCandidate / isCleanCandidate', () => {
  const clean = report(0, 0);

  it('behaves exactly like isBetterReport/isClean when neither candidate carries a fit', () => {
    expect(isBetterCandidate({ report: report(0, 25) }, { report: report(1, 0) })).toBe(isBetterReport(report(0, 25), report(1, 0)));
    expect(isCleanCandidate({ report: clean })).toBe(true);
    expect(isCleanCandidate({ report: report(0, 1) })).toBe(false);
  });

  it('ranks a fitting candidate over an equally error-free one that does not fit', () => {
    const fits = { report: clean, fit: checkFit({ width: 100, height: 100 }, 10, [200, 200]) };
    const doesNotFit = { report: clean, fit: checkFit({ width: 2000, height: 2000 }, 10, [200, 200]) };
    expect(isBetterCandidate(fits, doesNotFit)).toBe(true);
    expect(isBetterCandidate(doesNotFit, fits)).toBe(false);
    expect(isCleanCandidate(fits)).toBe(true);
    expect(isCleanCandidate(doesNotFit)).toBe(false);
  });

  it('still lets fewer errors win over a better fit — geometry outranks readable size', () => {
    const fewerErrorsBadFit = { report: report(1, 0), fit: checkFit({ width: 2000, height: 2000 }, 10, [200, 200]) };
    const moreErrorsGoodFit = { report: report(2, 0), fit: checkFit({ width: 100, height: 100 }, 10, [200, 200]) };
    expect(isBetterCandidate(fewerErrorsBadFit, moreErrorsGoodFit)).toBe(true);
  });
});
