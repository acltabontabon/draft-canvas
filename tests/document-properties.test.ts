import { expect, it } from 'vitest';
import fc from 'fast-check';
import { createDocument, createNode } from '../src/document/factory';
import { embed, viewOf } from '../src/depth/tree';
import { parseDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';

it('preserves root metadata and every room through nested edits and serialization', () => {
  fc.assert(fc.property(fc.array(fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,30}$/), { minLength: 1, maxLength: 4 }), (labels) => {
    let file = createDocument('Property test');
    const path: string[] = [];
    for (const label of labels) {
      const room = viewOf(file, path)!;
      const node = createNode({ type: 'service', text: label, x: 0, y: 0 });
      file = embed(file, path, { ...room, nodes: [node] });
      path.push(node.id);
    }
    const parsed = parseDocument(JSON.parse(serializeDocument(file)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.metadata.title).toBe('Property test');
    for (let depth = 0; depth < labels.length; depth += 1) {
      expect(viewOf(parsed.document, path.slice(0, depth))!.nodes[0]!.text).toBe(labels[depth]);
    }
  }), { seed: 20261012, numRuns: 100 });
});
