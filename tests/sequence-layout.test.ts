import { describe, expect, it } from 'vitest';
import { createAttachment, createNode } from '../src/document/factory';
import { LIMITS } from '../src/document/limits';
import { findItem, messagesOf } from '../src/document/sequenceModel';
import { addOperand, createFragment, createMessage, createNote, createReply, groupParticipants, insertItem, moveItem, wrapItems } from '../src/document/sequenceOps';
import type { DraftSequence, SeqFragment, SeqItem, SeqMessage, SeqParticipant } from '../src/document/types';
import { describeContext, describeNode, naturalSequenceSizeFor, sequenceLayoutFor } from '../src/nodes/describe';
import { sequenceAttachmentChips, UNNAMED_HEAD_WIDTH } from '../src/nodes/sequence';
import { LIGHT } from '../src/render/theme/tokens';
import {
  columnNear,
  hitSequence,
  layoutSequence,
  participantIndexAt,
  slotAt,
  slotFor,
  type Rect,
  type SequenceLayout,
} from '../src/sequence/layout';

const who = (id: string, name = id): SeqParticipant => ({ id, name, type: 'service', serviceKind: 'generic' });
const call = (id: string, from: string, to: string, label = id): SeqMessage => createMessage({ id, from, to, label });
const reply = (id: string, to: SeqMessage, label = id): SeqMessage => ({ ...createReply(to, label), id });

const lay = (sequence: DraftSequence, box?: { width: number; height: number }): SequenceLayout =>
  layoutSequence({ sequence, title: 'Checkout', box, headSize: () => ({ width: 110, height: 48 }) });

/** Shopper → Store → API → Database, with a branch, a parallel block and a loop. */
function checkout(): DraftSequence {
  const place = call('place', 'shopper', 'store', 'Place order');
  const post = call('post', 'store', 'api', 'POST /orders');
  const pay = call('pay', 'api', 'bank', 'authorize payment');
  const save = call('save', 'api', 'db', 'INSERT order');
  let sequence: DraftSequence = {
    participants: [who('shopper', 'Shopper'), who('store', 'Storefront'), who('api', 'Checkout API'), who('bank', 'Payment Provider'), who('db', 'Orders')],
    items: [place, post, call('check', 'api', 'api', 'validate cart'), pay, reply('paid', pay, 'approved'), save, reply('saved', save, 'order id'), reply('created', post, '201 Created'), reply('shown', place, 'Show the result')],
  };
  sequence = wrapItems(sequence, ['pay', 'created'], { id: 'alt', operator: 'alt', guard: 'card accepted' });
  sequence = wrapItems(sequence, ['save', 'saved'], { id: 'par', operator: 'par' });
  sequence = addOperand(sequence, 'alt', { id: 'declined', guard: 'declined' });
  sequence = insertItem(sequence, createMessage({ id: 'refuse', from: 'api', to: 'store', kind: 'reply', label: '402 Payment Required' }), { operandId: 'declined', index: 0 });
  sequence = insertItem(sequence, createNote({ id: 'note', over: ['api', 'db'], text: 'Nothing is stored for a declined card.' }), { operandId: 'declined', index: 0 });
  return sequence;
}

const within = (inner: Rect, outer: Rect, slop = 0.5): boolean =>
  inner.x >= outer.x - slop && inner.y >= outer.y - slop && inner.x + inner.w <= outer.x + outer.w + slop && inner.y + inner.h <= outer.y + outer.h + slop;

describe('columns', () => {
  it('stand left to right without their heads touching', () => {
    const layout = lay(checkout());
    for (let at = 1; at < layout.columns.length; at += 1) {
      const before = layout.columns[at - 1]!;
      const column = layout.columns[at]!;
      expect(column.x).toBeGreaterThan(before.x);
      expect(column.head.x).toBeGreaterThan(before.head.x + before.head.w);
    }
  });

  it('are spaced so a message’s words fit between the lifelines it runs between', () => {
    const long = 'reserve the stock for every line of this order';
    const sequence: DraftSequence = { participants: [who('a'), who('b'), who('c')], items: [call('m', 'a', 'b', long), call('far', 'a', 'c', `${long} and tell billing`)] };
    const layout = lay(sequence);
    for (const message of layout.messages) {
      const span = Math.abs(layout.columns.find((c) => c.id === message.to)!.x - layout.columns.find((c) => c.id === message.from)!.x);
      expect(message.label!.layout.width).toBeLessThanOrEqual(span);
    }
  });

  it('keeps all four named attachments inside a single-participant frame', () => {
    const attachments = Array.from({ length: 4 }, (_, at) =>
      createAttachment({ id: `a${at}`, type: 'code', language: 'javascript' }),
    );
    const layout = lay({ participants: [who('a')], items: [{ ...call('m', 'a', 'a', ''), attachments }] });
    const chips = sequenceAttachmentChips(layout.messages[0]!, attachments, layout.width, describeContext(LIGHT).measurer);
    const frame = { x: 0, y: 0, w: layout.width, h: layout.height };
    expect(chips).toHaveLength(4);
    expect(chips.every((chip) => within(chip, frame))).toBe(true);
  });

  it('a wider box spreads the lifelines and changes nothing else about what is needed', () => {
    const snug = lay(checkout());
    const wide = lay(checkout(), { width: snug.natural.width + 300, height: snug.natural.height });
    expect(wide.natural).toEqual(snug.natural);
    expect(wide.width).toBe(snug.natural.width + 300);
    const stretch = (layout: SequenceLayout) => layout.columns[layout.columns.length - 1]!.x - layout.columns[0]!.x;
    expect(stretch(wide)).toBeCloseTo(stretch(snug) + 300, 0);
    expect(wide.messages.map((message) => message.y)).toEqual(snug.messages.map((message) => message.y));
  });

  it('a taller box only lengthens the lifelines', () => {
    const snug = lay(checkout());
    const tall = lay(checkout(), { width: snug.natural.width, height: snug.natural.height + 120 });
    expect(tall.columns[0]!.lifeBottom).toBe(snug.columns[0]!.lifeBottom + 120);
    expect(tall.columns.map((column) => column.x)).toEqual(snug.columns.map((column) => column.x));
  });

  it('a box too small is drawn at what is needed, not squeezed', () => {
    const layout = lay(checkout(), { width: LIMITS.minNodeSize, height: LIMITS.minNodeSize });
    expect(layout.width).toBe(layout.natural.width);
    expect(layout.height).toBe(layout.natural.height);
  });
});

describe('rows', () => {
  it('run down the page in the order they are said', () => {
    const sequence = checkout();
    const layout = lay(sequence);
    const order = messagesOf(sequence).map((message) => layout.messages.find((entry) => entry.id === message.id)!.y);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it('a long label wraps and its row grows to hold it', () => {
    const short = lay({ participants: [who('a'), who('b')], items: [call('m', 'a', 'b', 'ok'), call('next', 'a', 'b', 'next')] });
    const long = lay({ participants: [who('a'), who('b')], items: [call('m', 'a', 'b', 'check every line of the order against the stock we hold in every warehouse we have'), call('next', 'a', 'b', 'next')] });
    expect(long.messages[0]!.label!.layout.lines.length).toBe(2);
    expect(long.messages[0]!.y).toBeGreaterThan(short.messages[0]!.y);
  });

  it('a message to itself loops out to the right and comes back lower down', () => {
    const layout = lay({ participants: [who('a'), who('b')], items: [call('self', 'a', 'a', 'validate')] });
    const [message] = layout.messages;
    expect(message!.self).toBe(true);
    expect(message!.yEnd).toBeGreaterThan(message!.y);
    expect(message!.label!.x).toBeGreaterThan(layout.columns[0]!.x);
    expect(message!.label!.x + message!.label!.layout.width).toBeLessThan(layout.columns[1]!.x);
  });
});

describe('fragments', () => {
  it('hold what is inside them, and sit inside what holds them', () => {
    const sequence = checkout();
    const layout = lay(sequence);
    const frame = (id: string) => layout.fragments.find((entry) => entry.id === id)!;
    for (const id of ['pay', 'paid', 'save', 'saved', 'created', 'refuse']) {
      expect(within(layout.boxes.get(id)!, frame('alt').box), id).toBe(true);
    }
    expect(within(frame('par').box, frame('alt').box)).toBe(true);
    expect(within(layout.boxes.get('place')!, frame('alt').box)).toBe(false);
    expect(frame('par').depth).toBe(1);
  });

  it('give every branch its own band, in order, with its condition', () => {
    const layout = lay(checkout());
    const alt = layout.fragments.find((entry) => entry.id === 'alt')!;
    expect(alt.operands.map((branch) => branch.guard?.layout.lines[0]?.text)).toEqual(['[card accepted]', '[declined]']);
    expect(alt.operands[0]!.separatorY).toBeNull();
    expect(alt.operands[1]!.separatorY).toBeGreaterThan(alt.operands[0]!.box.y);
    expect(alt.operands[1]!.box.y).toBeGreaterThanOrEqual(alt.operands[0]!.box.y + alt.operands[0]!.box.h - 0.5);
  });

  it('keep a tab clear of the lifeline beside it', () => {
    const layout = lay(checkout());
    for (const frame of layout.fragments) {
      const first = Math.min(...layout.columns.filter((column) => column.x >= frame.box.x).map((column) => column.x));
      expect(frame.tab.x + frame.tab.w).toBeLessThan(first - 5);
    }
  });

  it('an empty branch still has room to be dropped into', () => {
    const sequence = insertItem({ participants: [who('a'), who('b')], items: [] }, createFragment({ id: 'f', operator: 'opt', guard: 'maybe' }), { operandId: null, index: 0 });
    const layout = lay(sequence);
    const branch = (findItem(sequence, 'f')!.item as SeqFragment).operands[0]!.id;
    expect(layout.fragments[0]!.box.h).toBeGreaterThan(40);
    expect(slotFor(layout, branch, 0)).not.toBeNull();
  });

  it('nest to the limit without one frame touching the next', () => {
    let sequence: DraftSequence = { participants: [who('a'), who('b')], items: [call('m', 'a', 'b')] };
    for (let depth = 0; depth < LIMITS.maxSequenceDepth; depth += 1) sequence = wrapItems(sequence, ['m'], { id: `f${depth}`, operator: 'loop' });
    const layout = lay(sequence);
    const byDepth = [...layout.fragments].sort((a, b) => a.depth - b.depth);
    expect(byDepth).toHaveLength(LIMITS.maxSequenceDepth);
    for (let at = 1; at < byDepth.length; at += 1) {
      expect(within(byDepth[at]!.box, byDepth[at - 1]!.box, 0)).toBe(true);
      expect(byDepth[at]!.box.y).toBeGreaterThan(byDepth[at - 1]!.box.y);
    }
    expect(byDepth[0]!.box.x).toBeGreaterThanOrEqual(0);
  });
});

describe('everything fits', () => {
  const inFrame = (layout: SequenceLayout) => {
    const all: Rect = { x: 0, y: 0, w: layout.width, h: layout.height };
    for (const [id, box] of layout.boxes) expect(within(box, all), id).toBe(true);
  };

  it('a realistic sequence sits wholly inside the size it asks for', () => {
    inFrame(lay(checkout()));
  });

  it('thirty participants and three hundred messages do too, and lay out the same twice', () => {
    const participants = Array.from({ length: 30 }, (_, index) => who(`p${index}`, `Service ${index}`));
    const items: SeqItem[] = Array.from({ length: 300 }, (_, index) => call(`m${index}`, `p${index % 30}`, `p${(index * 7 + 3) % 30}`, `step ${index}`));
    const sequence: DraftSequence = { participants, items };
    const layout = lay(sequence);
    inFrame(layout);
    expect(lay({ participants, items })).toEqual(layout);
  });

  it('grouped participants stand together inside their band', () => {
    const sequence = groupParticipants(checkout(), ['store', 'api'], { id: 'g', name: 'Our systems' });
    const layout = lay(sequence);
    const band = layout.groups[0]!.box;
    for (const id of ['store', 'api']) expect(within(layout.boxes.get(id)!, band)).toBe(true);
    for (const id of ['shopper', 'bank']) expect(within(layout.boxes.get(id)!, band)).toBe(false);
    inFrame(layout);
  });

  it('an empty sequence still has a size', () => {
    const layout = lay({ participants: [], items: [] });
    expect(layout.natural.width).toBeGreaterThan(0);
    expect(layout.natural.height).toBeGreaterThan(0);
  });
});

describe('lifetimes and work', () => {
  it('a bar runs from the call that starts work to the reply that ends it', () => {
    const post = call('post', 'a', 'b');
    const layout = lay({ participants: [who('a'), who('b')], items: [post, reply('done', post)] });
    const [bar] = layout.executions;
    const [first, last] = layout.messages;
    expect(bar!.box.y).toBe(first!.y);
    expect(bar!.box.y + bar!.box.h).toBe(last!.y);
    // The arrows meet the bar's edge, not the lifeline behind it.
    expect(first!.x2).toBe(bar!.box.x);
    expect(last!.x1).toBe(bar!.box.x);
  });

  it('a created participant’s head sits on the message that creates it', () => {
    const make = createMessage({ id: 'new', from: 'a', to: 'b', kind: 'create', label: 'new Cart' });
    const layout = lay({ participants: [who('a'), who('b')], items: [call('first', 'a', 'a'), make] });
    const created = layout.columns[1]!;
    const message = layout.messages.find((entry) => entry.id === 'new')!;
    expect(created.created).toBe(true);
    expect(created.head.y + created.head.h / 2).toBeCloseTo(message.y);
    expect(message.x2).toBe(created.head.x);
    expect(created.lifeTop).toBeGreaterThan(layout.columns[0]!.lifeTop);
  });

  it('a destroyed participant’s lifeline ends there', () => {
    const end = createMessage({ id: 'end', from: 'a', to: 'b', kind: 'destroy' });
    const layout = lay({ participants: [who('a'), who('b')], items: [call('first', 'a', 'b'), end] });
    expect(layout.columns[1]!.destroyed).toBe(true);
    expect(layout.columns[1]!.lifeBottom).toBe(layout.messages[1]!.y);
    expect(layout.columns[0]!.lifeBottom).toBeGreaterThan(layout.columns[1]!.lifeBottom);
  });
});

describe('finding things', () => {
  it('numbers message arrows in reading order across fragments', () => {
    const layout = lay(checkout());
    expect(layout.messages.map(({ id, number }) => [id, number])).toEqual(
      messagesOf(checkout()).map(({ id }, index) => [id, index + 1]),
    );
  });

  it('leaves an insertion target clear of a self-message and the message after it', () => {
    const layout = lay({ participants: [who('a'), who('b')], items: [call('self', 'a', 'a'), call('next', 'a', 'b')] });
    const [self, next] = layout.messages;
    const slot = slotFor(layout, null, 1)!;
    expect(slot.y - (self!.box.y + self!.box.h)).toBeGreaterThanOrEqual(9);
    expect(next!.box.y - slot.y).toBeGreaterThanOrEqual(9);
    expect(hitSequence(layout, layout.columns[0]!.x, slot.y)).toEqual({ kind: 'lifeline', participantId: 'a' });
  });

  it('a point on a message, a head, a frame’s tab and a lifeline each find what is there', () => {
    const layout = lay(checkout());
    const post = layout.messages.find((message) => message.id === 'post')!;
    expect(hitSequence(layout, (post.x1 + post.x2) / 2, post.y)).toEqual({ kind: 'message', id: 'post' });
    const head = layout.columns[2]!.head;
    expect(hitSequence(layout, head.x + head.w / 2, head.y + head.h / 2)).toEqual({ kind: 'participant', id: 'api' });
    const alt = layout.fragments.find((frame) => frame.id === 'alt')!;
    expect(hitSequence(layout, alt.tab.x + 4, alt.tab.y + 4)).toEqual({ kind: 'fragment', id: 'alt' });
    const shopper = layout.columns[0]!;
    expect(hitSequence(layout, shopper.x, shopper.lifeBottom - 4)).toEqual({ kind: 'lifeline', participantId: 'shopper' });
    expect(hitSequence(layout, layout.width - 3, 3)).toEqual({ kind: 'body' });
  });

  it('a point inside a branch inserts into that branch; outside, into the sequence', () => {
    const sequence = checkout();
    const layout = lay(sequence);
    const paid = layout.messages.find((message) => message.id === 'paid')!;
    const inside = slotAt(layout, paid.x1, paid.y + 6)!;
    expect(inside.operandId).toBe((findItem(sequence, 'alt')!.item as SeqFragment).operands[0]!.id);
    const place = layout.messages.find((message) => message.id === 'place')!;
    expect(slotAt(layout, place.x1, place.y + 6)).toMatchObject({ operandId: null, index: 1 });
    expect(slotAt(layout, place.x1, layout.height + 500)).toMatchObject({ operandId: null, index: sequence.items.length });
  });

  it('every place in every list has a slot, in order down the page', () => {
    const sequence = checkout();
    const layout = lay(sequence);
    const root = layout.slots.filter((slot) => slot.operandId === null);
    expect(root.map((slot) => slot.index)).toEqual(sequence.items.map((_, index) => index).concat(sequence.items.length));
    expect(root.map((slot) => slot.y)).toEqual([...root.map((slot) => slot.y)].sort((a, b) => a - b));
  });

  it('a dropped participant goes before the first lifeline to its right', () => {
    const layout = lay(checkout());
    expect(participantIndexAt(layout, 0)).toBe(0);
    expect(participantIndexAt(layout, layout.columns[1]!.x + 1)).toBe(2);
    expect(participantIndexAt(layout, layout.width)).toBe(5);
    expect(columnNear(layout, layout.columns[3]!.x + 4, 10)!.id).toBe('bank');
    expect(columnNear(layout, layout.columns[3]!.x + 40, 10)).toBeNull();
  });

  it('moving a message moves its row and nobody else’s order', () => {
    const sequence = checkout();
    const moved = moveItem(sequence, 'check', { operandId: null, index: 0 });
    const order = (layout: SequenceLayout) => [...layout.messages].sort((a, b) => a.y - b.y).map((message) => message.id);
    expect(order(lay(moved))).toEqual(messagesOf(moved).map((message) => message.id));
  });
});

describe('as a node', () => {
  const ctx = describeContext(LIGHT);

  it('draws real shapes for heads, and the same picture twice', () => {
    const node = { ...createNode({ type: 'sequence', x: 0, y: 0, text: 'Checkout' }), sequence: checkout() };
    const sized = { ...node, ...naturalSequenceSizeFor(node, ctx) };
    const drawn = describeNode(sized, ctx);
    expect(drawn.shapes.filter((shape) => shape.t === 'group')).toHaveLength(5);
    expect(describeNode(sized, ctx)).toEqual(drawn);
    expect(sequenceLayoutFor(sized, ctx)).toBe(sequenceLayoutFor(sized, ctx));
  });

  it('one still waiting for its name stands as wide as the field it is typed in, so the field covers nobody else', () => {
    const blank = { id: 'new', name: '', type: 'service' as const };
    const sequence = { ...checkout(), participants: [checkout().participants[0]!, blank, ...checkout().participants.slice(1)] };
    const node = { ...createNode({ type: 'sequence', x: 0, y: 0, text: 'Checkout' }), sequence };
    const layout = sequenceLayoutFor({ ...node, ...naturalSequenceSizeFor(node, ctx) }, ctx);
    const [left, made, right] = layout.columns;
    expect(made!.head.w).toBeGreaterThanOrEqual(UNNAMED_HEAD_WIDTH);
    expect(left!.head.x + left!.head.w).toBeLessThan(made!.head.x);
    expect(made!.head.x + made!.head.w).toBeLessThan(right!.head.x);
  });

  it('the size it asks for does not depend on the box it is in', () => {
    const node = { ...createNode({ type: 'sequence', x: 0, y: 0, text: 'Checkout' }), sequence: checkout() };
    const natural = naturalSequenceSizeFor(node, ctx);
    const roomy: typeof node = { ...node, width: 2000, height: 2000 };
    expect(naturalSequenceSizeFor(roomy, ctx)).toEqual(natural);
    expect(sequenceLayoutFor({ ...node, width: natural.width, height: natural.height }, ctx).natural).toEqual(natural);
  });

  it('a sequence with nothing in it, or no payload at all, still draws its frame and title', () => {
    const bare = createNode({ type: 'sequence', x: 0, y: 0, text: 'Empty' });
    const { sequence: _none, ...headless } = bare;
    for (const node of [bare, headless]) {
      const shapes = describeNode(node, ctx).shapes;
      expect(shapes[0]!.t).toBe('rect');
      expect(shapes.some((shape) => shape.t === 'text' && shape.role === 'label')).toBe(true);
    }
  });
});
