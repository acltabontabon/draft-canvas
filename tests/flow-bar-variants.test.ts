import { describe, expect, it } from 'vitest';
import { orderedWithVariants } from '../src/presentation/flowChrome';
import { createFlow } from '../src/document/flow';

describe('orderedWithVariants (FlowPicker grouping)', () => {
  it('places a variant right after its base, even if it appears earlier in the document', () => {
    const normal = createFlow({ id: 'fnorm', title: 'Payment' });
    const failure = { ...createFlow({ id: 'ffail', title: 'Payment — failure path' }), variantOf: 'fnorm' };
    // Variant listed first in the document — grouping must not just preserve document order verbatim.
    const rows = orderedWithVariants([failure, normal]);
    expect(rows.map((r) => r.flow.id)).toEqual(['fnorm', 'ffail']);
    expect(rows.map((r) => r.variant)).toEqual([false, true]);
  });

  it('leaves unrelated flows untouched and in their original relative order', () => {
    const a = createFlow({ id: 'a', title: 'A' });
    const b = createFlow({ id: 'b', title: 'B' });
    const rows = orderedWithVariants([a, b]);
    expect(rows).toEqual([
      { flow: a, variant: false },
      { flow: b, variant: false },
    ]);
  });

  it('falls back to its own row when a variant\'s base is not in the list', () => {
    const orphan = { ...createFlow({ id: 'f1', title: 'Orphaned variant' }), variantOf: 'missing' };
    const rows = orderedWithVariants([orphan]);
    expect(rows).toEqual([{ flow: orphan, variant: false }]);
  });
});
