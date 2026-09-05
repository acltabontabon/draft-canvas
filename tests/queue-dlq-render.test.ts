import { describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { describeContext, describeNode } from '../src/nodes/describe';
import { LIGHT } from '../src/render/theme/tokens';
import type { PathShape, TextShape } from '../src/render/displayList';

const clean = describeContext(LIGHT, 'clean');

function pathShapes(node: ReturnType<typeof createNode>) {
  return describeNode(node, clean).shapes.filter((s): s is PathShape => s.t === 'path');
}

function textOf(node: ReturnType<typeof createNode>): string[] {
  return describeNode(node, clean)
    .shapes.filter((s): s is TextShape => s.t === 'text')
    .flatMap((s) => s.layout.lines.map((l) => l.text));
}

describe('a generated DLQ node renders with visibly subordinate treatment', () => {
  it('captions "DLQ" regardless of queueKind', () => {
    const dlq = createNode({ type: 'queue', deliveryRole: 'dead-letter', x: 0, y: 0 });
    expect(textOf(dlq)).toContain('DLQ');
    expect(textOf(dlq)).not.toContain('QUEUE');
  });

  it('gets a dashed tube outline and reduced opacity a plain queue does not', () => {
    const plain = createNode({ type: 'queue', x: 0, y: 0 });
    const dlq = createNode({ type: 'queue', deliveryRole: 'dead-letter', x: 0, y: 0 });

    const plainShapes = pathShapes(plain);
    const dlqShapes = pathShapes(dlq);

    expect(plainShapes.every((s) => s.stroke?.dash === undefined)).toBe(true);
    expect(plainShapes.every((s) => s.opacity === undefined)).toBe(true);

    expect(dlqShapes.some((s) => s.stroke?.dash !== undefined)).toBe(true);
    expect(dlqShapes.some((s) => s.opacity !== undefined && s.opacity < 1)).toBe(true);
  });

  it('never dims the caption text itself — it stays fully legible', () => {
    const dlq = createNode({ type: 'queue', deliveryRole: 'dead-letter', x: 0, y: 0 });
    const textShapes = describeNode(dlq, clean).shapes.filter((s): s is TextShape => s.t === 'text');
    expect(textShapes.every((s) => s.opacity === undefined)).toBe(true);
  });

  it('uses a single-envelope icon path distinct from a plain queue\'s three-envelope cluster', () => {
    const plain = createNode({ type: 'queue', x: 0, y: 0 });
    const dlq = createNode({ type: 'queue', deliveryRole: 'dead-letter', x: 0, y: 0 });
    // The icon cluster is the third path shape (tube body, tube lid, then icons) — see queue()'s
    // own shape-push order in nodes/describe.ts.
    const plainIcons = pathShapes(plain)[2]!.d;
    const dlqIcons = pathShapes(dlq)[2]!.d;
    expect(dlqIcons).not.toBe(plainIcons);
    // A single envelope is 8 path commands (M,h,v,h,Z,M,L,L); three envelopes joined is 24.
    expect(dlqIcons.split(' ').filter((token) => /^[a-zA-Z]/.test(token)).length).toBe(8);
    expect(plainIcons.split(' ').filter((token) => /^[a-zA-Z]/.test(token)).length).toBe(24);
  });

  it('a plain queue (no deliveryRole) is completely unaffected', () => {
    const plain = createNode({ type: 'queue', x: 0, y: 0 });
    expect(textOf(plain)).toContain('QUEUE');
    expect(pathShapes(plain).every((s) => s.stroke?.dash === undefined && s.opacity === undefined)).toBe(true);
  });
});
