import { describe, expect, it } from 'vitest';
import { historyContent, withLiveBookkeeping } from '../../src/document/content';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { addEdges, addNodes, updateNode } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import { isEmptyDiff, semanticDiff } from '../../src/evolution/diff';
import { blobId } from '../../src/evolution/hash';
import { historyText, readHistoryText } from '../../src/evolution/snapshot';
import { describe as describeChange } from '../../src/evolution/summary';
import { randomEdit, rngFrom, seededFile } from '../collab/support';

function base(): DraftDocument {
  let doc = createDocument('Payments');
  doc = addNodes(doc, [
    createNode({ type: 'service', x: 0, y: 0, id: 'n_api', text: 'API Gateway' }),
    createNode({ type: 'service', x: 300, y: 0, id: 'n_orders', text: 'Order Service' }),
  ]);
  return doc;
}

describe('the history content model', () => {
  it('ignores the camera and the save time, and nothing else', () => {
    const doc = base();
    const panned = { ...doc, viewport: { x: 120, y: -40, zoom: 1.7 }, metadata: { ...doc.metadata, updatedAt: doc.metadata.updatedAt + 5000 } };
    expect(historyText(panned)).toBe(historyText(doc));
    expect(historyText(updateNode(doc, 'n_api', { x: 1 }))).not.toBe(historyText(doc));
    expect(historyText({ ...doc, metadata: { ...doc.metadata, title: 'Other' } })).not.toBe(historyText(doc));
  });

  it('is idempotent and keeps unchanged content by identity', () => {
    const doc = base();
    const once = historyContent(doc);
    expect(historyContent(once)).toBe(once);
    expect(once.nodes).toBe(doc.nodes);
  });

  it('reads back what it wrote', () => {
    const doc = historyContent(base());
    const { document, repaired } = readHistoryText(historyText(doc));
    expect(repaired).toBe(false);
    expect(historyText(document)).toBe(historyText(doc));
  });

  it('restores content with the live camera and identity', () => {
    const old = historyContent(base());
    const live = { ...base(), viewport: { x: 9, y: 9, zoom: 2 } };
    const restored = withLiveBookkeeping(old, { ...live, metadata: { ...live.metadata, id: 'd_live' } });
    expect(restored.viewport).toEqual({ x: 9, y: 9, zoom: 2 });
    expect(restored.metadata.id).toBe('d_live');
    expect(restored.nodes).toBe(old.nodes);
  });

  it('gives Git’s own blob id', async () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(await blobId('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('the semantic diff agrees with the bytes', () => {
  it('lists a change exactly when the history bytes differ (seeded)', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rng = rngFrom(seed);
      let doc = seededFile(rng, 6);
      for (let step = 0; step < 6; step += 1) {
        const next = randomEdit(doc, rng);
        const bytesDiffer = historyText(next) !== historyText(doc);
        const diff = semanticDiff(historyContent(doc), historyContent(next));
        expect({ seed, step, listed: !isEmptyDiff(diff) }).toEqual({ seed, step, listed: bytesDiffer });
        doc = next;
      }
    }
  });

  it('is deterministic', () => {
    const rng = rngFrom(99);
    const a = seededFile(rng, 10);
    const b = randomEdit(randomEdit(a, rng), rng);
    expect(JSON.stringify(semanticDiff(a, b))).toBe(JSON.stringify(semanticDiff(a, b)));
    expect(describeChange(semanticDiff(a, b))).toEqual(describeChange(semanticDiff(a, b)));
  });
});

describe('revision messages', () => {
  const doc = base();
  it('names what was added', () => {
    const next = addNodes(doc, [createNode({ type: 'database', x: 0, y: 200, id: 'n_db', text: 'PostgreSQL' })]);
    expect(describeChange(semanticDiff(doc, next)).summary).toBe('Add PostgreSQL');
  });

  it('says which shapes a new connector joins', () => {
    const next = addEdges(doc, [createEdge({ id: 'e_1', source: 'n_api', target: 'n_orders' })]);
    expect(describeChange(semanticDiff(doc, next)).summary).toBe('Connect API Gateway to Order Service');
  });

  it('calls a move a move and a rename an edit of text', () => {
    expect(describeChange(semanticDiff(doc, updateNode(doc, 'n_api', { x: 40 }))).summary).toBe('Move API Gateway');
    expect(describeChange(semanticDiff(doc, updateNode(doc, 'n_api', { text: 'Edge' }))).summary).toBe('Edit the text of Edge');
    const both = updateNode(updateNode(doc, 'n_api', { x: 40 }), 'n_orders', { y: 30 });
    expect(describeChange(semanticDiff(doc, both)).summary).toBe('Refine the layout of 2 shapes');
  });

  it('lists every change in the body, and its categories', () => {
    const next = addEdges(addNodes(doc, [createNode({ type: 'queue', x: 0, y: 300, id: 'n_q', text: 'Events' })]), [createEdge({ id: 'e_2', source: 'n_orders', target: 'n_q' })]);
    const description = describeChange(semanticDiff(doc, next));
    expect(description.summary).toBe('Add Events and 1 connection');
    expect(description.body).toHaveLength(2);
    expect(description.categories).toEqual(['structure', 'relationships']);
  });

  it('starts a history with one description of everything', () => {
    expect(describeChange(semanticDiff(null, doc)).summary).toBe('Add API Gateway and Order Service');
  });
});
