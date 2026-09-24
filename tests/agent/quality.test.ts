/**
 * `checkQuality`/`isBetterReport` (`agent/quality.ts`): warnings are detected, weighed correctly
 * against errors when candidates are compared, and actually drive the repair ladder that picks
 * among them.
 */
import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { measureContext } from '../../src/agent/place';
import { checkQuality, isBetterReport, isClean, type QualityReport } from '../../src/agent/quality';
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
});
