import { describe, expect, it } from 'vitest';
import { decodeClipboard, encodeClipboard } from '../src/document/clipboardCodec';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { LIMITS } from '../src/document/limits';
import { addNodes, extractFragment, pasteFragment } from '../src/document/operations';
import { countItems, heightOf, messagesOf } from '../src/document/sequenceModel';
import { createMessage, createReply, wrapItems } from '../src/document/sequenceOps';
import { CURRENT_VERSION, DRAFT_FORMAT, type DraftDocument, type DraftSequence } from '../src/document/types';
import { parseDocument } from '../src/document/validate';
import { normalizeSequence } from '../src/document/validateSequence';
import { serializeDocument } from '../src/export/project';

const who = (id: string, extra: Record<string, unknown> = {}) =>
  extra.type && extra.type !== 'service' ? { id, name: id, ...extra } : { id, name: id, type: 'service', serviceKind: 'generic', ...extra };

function sample(): DraftSequence {
  const call = createMessage({ id: 'm1', from: 'a', to: 'b', label: 'GET /cart' });
  const base: DraftSequence = {
    participants: [who('a'), who('b', { technology: 'Spring Boot' }), who('c', { type: 'database', databaseKind: 'sql' })] as DraftSequence['participants'],
    items: [call, { ...createReply(call, '200'), id: 'r1' }],
    groups: [{ id: 'g1', name: 'Backend', participantIds: ['b', 'c'] }],
  };
  return wrapItems(base, ['m1', 'r1'], { id: 'f1', operator: 'opt', guard: 'signed in' });
}

function documentWith(sequence: unknown): DraftDocument {
  const node = { ...createNode({ type: 'sequence', x: 40, y: 40, text: 'Checkout' }), sequence: sequence as DraftSequence };
  return addNodes(createDocument('Shop'), [node]);
}

describe('reading a sequence', () => {
  it('a sound sequence comes back exactly as it was', () => {
    const start = sample();
    expect(normalizeSequence(start)).toEqual({ sequence: start, dropped: 0 });
  });

  it('survives the file format untouched', () => {
    const doc = documentWith({ ...sample(), numberMessages: false });
    const result = parseDocument(serializeDocument(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toEqual([]);
    expect(result.document.nodes[0]).toEqual(doc.nodes[0]);
    expect(result.document.version).toBe(CURRENT_VERSION);
  });

  it('keeps participant attachments on connectors between sequences', () => {
    const doc = documentWith(sample());
    const source = doc.nodes[0]!.id;
    const target = { ...createNode({ type: 'sequence', x: 720, y: 40 }), sequence: sample() };
    const edge = createEdge({
      source,
      target: target.id,
      sourceAnchor: { side: 'right', offset: 0.25, participantId: 'b' },
      targetAnchor: { side: 'left', offset: 0.5, participantId: 'a' },
    });
    const result = parseDocument(serializeDocument({ ...doc, nodes: [...doc.nodes, target], edges: [edge] }));
    expect(result.ok && result.document.edges[0]).toMatchObject({
      sourceAnchor: edge.sourceAnchor,
      targetAnchor: edge.targetAnchor,
    });
  });

  it('a sequence node with nothing in it reads as an empty sequence, not a note', () => {
    const raw = { format: DRAFT_FORMAT, version: CURRENT_VERSION, metadata: { id: 'd', title: 't', createdAt: 0, updatedAt: 0 }, nodes: [{ id: 'n', type: 'sequence', x: 0, y: 0, width: 300, height: 200 }], edges: [], flows: [] };
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]).toMatchObject({ type: 'sequence', sequence: { participants: [], items: [] } });
  });

  it('a file from before sequences existed still opens, and moves up a version', () => {
    const raw = { format: DRAFT_FORMAT, version: 25, metadata: { id: 'd', title: 't', createdAt: 0, updatedAt: 0 }, nodes: [{ id: 'n', type: 'service', x: 0, y: 0, width: 176, height: 68, text: 'API' }], edges: [], flows: [] };
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.document.nodes[0]!.sequence).toBeUndefined();
  });

  it('drops a message to a participant that is not there, and says so', () => {
    const { sequence, dropped } = normalizeSequence({
      participants: [who('a'), who('b')],
      items: [
        { id: 'ok', t: 'message', from: 'a', to: 'b', kind: 'sync', label: 'fine' },
        { id: 'lost', t: 'message', from: 'a', to: 'ghost', kind: 'sync', label: 'gone' },
        { id: 'odd', t: 'spaceship' },
      ],
    });
    expect(messagesOf(sequence).map((message) => message.id)).toEqual(['ok']);
    expect(dropped).toBe(2);
  });

  it('repairs what it can: unknown kinds, a second participant with a taken id, a reply to nothing', () => {
    const { sequence } = normalizeSequence({
      participants: [who('a'), who('b', { type: 'spaceship' }), who('a', { name: 'twin' })],
      items: [{ id: 'r', t: 'message', from: 'b', to: 'a', kind: 'reply', replyTo: 'nowhere', label: 'x', activate: 'yes' }],
    });
    expect(sequence.participants.map((participant) => participant.id)).toEqual(['a', 'b']);
    expect(sequence.participants[1]).toMatchObject({ type: 'service', serviceKind: 'generic' });
    expect(sequence.items[0]).toEqual({ id: 'r', t: 'message', from: 'b', to: 'a', kind: 'reply', label: 'x' });
  });

  it('nesting past the limit is opened out and the messages kept', () => {
    let items: unknown[] = [{ id: 'deep', t: 'message', from: 'a', to: 'b', kind: 'sync', label: 'deep' }];
    for (let depth = 0; depth < LIMITS.maxSequenceDepth + 4; depth += 1) {
      items = [{ id: `f${depth}`, t: 'fragment', operator: 'loop', operands: [{ id: `o${depth}`, items }] }];
    }
    const { sequence } = normalizeSequence({ participants: [who('a'), who('b')], items });
    expect(messagesOf(sequence).map((message) => message.id)).toEqual(['deep']);
    expect(heightOf(sequence.items[0]!)).toBe(LIMITS.maxSequenceDepth);
  });

  it('never keeps more than the limit, whatever it is handed', () => {
    const items = Array.from({ length: LIMITS.maxSequenceItems + 50 }, (_, index) => ({ id: `m${index}`, t: 'message', from: 'a', to: 'b', kind: 'sync', label: '' }));
    const participants = Array.from({ length: LIMITS.maxSequenceParticipants + 9 }, (_, index) => who(index === 0 ? 'a' : index === 1 ? 'b' : `p${index}`));
    const { sequence, dropped } = normalizeSequence({ participants, items });
    expect(sequence.participants).toHaveLength(LIMITS.maxSequenceParticipants);
    expect(countItems(sequence.items)).toBe(LIMITS.maxSequenceItems);
    expect(dropped).toBe(59);
  });

  it('a one-branch fragment handed several keeps their messages in one', () => {
    const message = (id: string) => ({ id, t: 'message', from: 'a', to: 'b', kind: 'sync', label: id });
    const { sequence } = normalizeSequence({
      participants: [who('a'), who('b')],
      items: [{ id: 'f', t: 'fragment', operator: 'loop', operands: [{ id: 'o1', items: [message('one')] }, { id: 'o2', items: [message('two')] }] }],
    });
    expect(sequence.items[0]).toMatchObject({ operator: 'loop', operands: [{ id: 'o1' }] });
    expect(messagesOf(sequence).map((entry) => entry.id)).toEqual(['one', 'two']);
  });

  it('a group keeps only members standing together', () => {
    const { sequence } = normalizeSequence({
      participants: [who('a'), who('b'), who('c')],
      items: [],
      groups: [{ id: 'g', name: 'Split', participantIds: ['a', 'c', 'ghost'] }],
    });
    expect(sequence.groups).toEqual([{ id: 'g', name: 'Split', participantIds: ['a'] }]);
  });

  it('text is held to the same limits as everywhere else', () => {
    const { sequence } = normalizeSequence({
      participants: [who('a', { name: `line one\nline two ${'x'.repeat(500)}` }), who('b')],
      items: [{ id: 'm', t: 'message', from: 'a', to: 'b', kind: 'sync', label: `bad\u0000label${'y'.repeat(2000)}` }],
    });
    expect(sequence.participants[0]!.name).toHaveLength(LIMITS.maxSequenceNameLength);
    expect(sequence.participants[0]!.name).not.toContain('\n');
    const label = messagesOf(sequence)[0]!.label;
    expect(label).toHaveLength(LIMITS.maxLabelLength);
    expect(label).not.toContain('\u0000');
  });
});

describe('copying a sequence', () => {
  it('goes through the clipboard whole', () => {
    const doc = documentWith(sample());
    const back = decodeClipboard(encodeClipboard(extractFragment(doc, [doc.nodes[0]!.id])));
    expect(back?.nodes[0]?.sequence).toEqual(doc.nodes[0]!.sequence);
  });

  it('pasted with the shape a participant stands for, it follows the copy; alone, the original', () => {
    const shape = createNode({ type: 'service', x: 600, y: 0, text: 'b' });
    const linked: DraftSequence = { ...sample(), participants: sample().participants.map((participant) => (participant.id === 'b' ? { ...participant, ref: shape.id } : participant)) };
    const doc = addNodes(documentWith(linked), [shape]);
    const sequenceId = doc.nodes[0]!.id;

    const together = pasteFragment(doc, extractFragment(doc, [sequenceId, shape.id]), { x: 20, y: 20 });
    const copy = together.doc.nodes.find((node) => node.id === together.nodeIds[0])!;
    const copiedShape = together.doc.nodes.find((node) => node.id === together.nodeIds[1])!;
    expect(copy.sequence!.participants.find((participant) => participant.id === 'b')!.ref).toBe(copiedShape.id);

    const alone = pasteFragment(doc, extractFragment(doc, [sequenceId]), { x: 20, y: 20 });
    const lone = alone.doc.nodes.find((node) => node.id === alone.nodeIds[0])!;
    expect(lone.sequence!.participants.find((participant) => participant.id === 'b')!.ref).toBe(shape.id);
  });
});

it('preserves bounded message attachments through validation, canonical save and clipboard', () => {
  const sequence = sample();
  const first = messagesOf(sequence)[0]!;
  const note = { id: 'note', type: 'note' as const, text: 'Paid orders only' };
  const code = { id: 'code', type: 'code' as const, language: 'json' as const, code: '{"status":"paid"}' };
  const attached = [note, code, { ...note, id: 'third' }, { ...code, id: 'fourth' }, { ...note, id: 'overflow' }];
  const node = { ...createNode({ id: 'host', type: 'sequence', x: 0, y: 0 }), sequence: {
    ...sequence, items: [{ ...first, attachments: attached }],
  } };
  const doc = addNodes(createDocument(), [node]);
  const parsed = parseDocument(JSON.parse(serializeDocument(doc)));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const kept = messagesOf(parsed.document.nodes[0]!.sequence!)[0]!.attachments;
  expect(kept?.map((attachment) => attachment.id)).toEqual(['note', 'code', 'third', 'fourth']);
  const selection = extractFragment(parsed.document, [node.id]);
  const loaded = decodeClipboard(encodeClipboard(selection));
  expect(loaded?.nodes[0]?.sequence && messagesOf(loaded.nodes[0].sequence)[0]?.attachments).toEqual(kept);
});
