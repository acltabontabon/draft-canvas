import { beforeEach, describe, expect, it } from 'vitest';
import { participantOptions } from '../src/canvas/sequence/participantOptions';
import { stepSlot } from '../src/canvas/sequence/sequenceKeys';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { findItem, messagesOf } from '../src/document/sequenceModel';
import { addOperand, createMessage, createReply, setMessageKind, wrapItems } from '../src/document/sequenceOps';
import type { DraftSequence, SeqFragment, SeqMessage, SeqParticipant } from '../src/document/types';
import { describeSequenceFocus, itemRange, neighbourItem } from '../src/sequence/focus';
import { defaultMessageLabel, labelSuggestions, nextFromParticipant, nextMessages, suggestedKind } from '../src/sequence/suggest';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { sequenceActions, sequenceIn } from '../src/store/sequenceActions';
import { useUiStore } from '../src/store/uiStore';

const who = (id: string, extra: Partial<SeqParticipant> = {}): SeqParticipant => ({ id, name: id, type: 'service', serviceKind: 'generic', ...extra });
const call = (id: string, from: string, to: string): SeqMessage => createMessage({ id, from, to, label: id });

function three(): DraftSequence {
  const get = call('get', 'client', 'api');
  const select = call('select', 'api', 'db');
  return {
    participants: [who('client', { type: 'actor', actorKind: 'human' }), who('api'), who('db', { type: 'database', databaseKind: 'sql' })],
    items: [get, select, { ...createReply(select, 'rows'), id: 'rows' }, { ...createReply(get, 'ok'), id: 'ok' }],
  };
}

describe('moving with the arrows', () => {
  it('steps past a neighbour, and stops at the ends', () => {
    expect(stepSlot(three(), 'select', -1)).toEqual({ operandId: null, index: 0 });
    expect(stepSlot(three(), 'select', 1)).toEqual({ operandId: null, index: 3 });
    expect(stepSlot(three(), 'get', -1)).toBeNull();
    expect(stepSlot(three(), 'ok', 1)).toBeNull();
  });

  it('goes into a fragment that is in the way, across its branches, and out the other side', () => {
    let sequence = wrapItems(three(), ['select', 'rows'], { id: 'f', operator: 'alt' });
    sequence = addOperand(sequence, 'f', { id: 'else' });
    const first = (findItem(sequence, 'f')!.item as SeqFragment).operands[0]!.id;
    expect(stepSlot(sequence, 'get', 1)).toEqual({ operandId: first, index: 0 });
    expect(stepSlot(sequence, 'ok', -1)).toEqual({ operandId: 'else', index: 0 });
    expect(stepSlot(sequence, 'rows', 1)).toEqual({ operandId: 'else', index: 0 });
    expect(stepSlot(sequence, 'select', -1)).toEqual({ operandId: null, index: 1 });
  });
});

describe('selecting', () => {
  it('a range is every item between the two, in their list', () => {
    expect(itemRange(three(), 'select', 'ok')).toEqual(['select', 'rows', 'ok']);
    expect(itemRange(three(), 'ok', 'select')).toEqual(['select', 'rows', 'ok']);
    const wrapped = wrapItems(three(), ['select'], { id: 'f', operator: 'opt' });
    expect(itemRange(wrapped, 'get', 'select')).toEqual(['select']);
  });

  it('reads in order, a fragment before what it holds', () => {
    const wrapped = wrapItems(three(), ['select', 'rows'], { id: 'f', operator: 'opt' });
    expect(neighbourItem(wrapped, 'get', 1)).toBe('f');
    expect(neighbourItem(wrapped, 'f', 1)).toBe('select');
    expect(neighbourItem(wrapped, 'ok', 1)).toBeNull();
  });

  it('is said in words', () => {
    const sequence = three();
    expect(describeSequenceFocus(sequence, 'item', ['get'])).toBe('Call from client to api: get');
    expect(describeSequenceFocus(sequence, 'item', ['rows'])).toBe('Reply from db to api: rows');
    expect(describeSequenceFocus(sequence, 'participant', ['db'])).toBe('db, participant');
    expect(describeSequenceFocus(sequence, 'item', ['get', 'select'])).toBe('2 selected');
  });
});

describe('what is offered', () => {
  const messaging: DraftSequence = {
    participants: [who('orders'), who('events', { type: 'queue', queueKind: 'topic', technology: 'Kafka' }), who('billing')],
    items: [call('publish', 'orders', 'events'), call('charge', 'orders', 'billing')],
  };

  it('suggests an asynchronous message into a topic, and changes nothing until it is taken', () => {
    const publish = messagesOf(messaging)[0]!;
    expect(publish.kind).toBe('sync');
    expect(suggestedKind(messaging, publish)).toEqual({ kind: 'async', reason: 'events is a topic: whoever sends to it does not usually wait.' });
    expect(suggestedKind(messaging, messagesOf(messaging)[1]!)).toBeNull();
  });

  it('never suggests against a kind someone chose', () => {
    const chosen = setMessageKind(setMessageKind(messaging, 'publish', 'async'), 'publish', 'sync');
    expect(suggestedKind(chosen, messagesOf(chosen)[0]!)).toBeNull();
  });

  it('uses canvas captions for participant shapes and their technology-derived kinds', () => {
    const sequence: DraftSequence = {
      participants: [...messaging.participants, who('db', { type: 'database' }), who('cache', { type: 'database', databaseKind: 'cache', technology: 'Redis' })],
      items: [],
    };
    expect(defaultMessageLabel(sequence, { from: 'orders', to: 'db' })).toBe('reads / writes');
    expect(defaultMessageLabel(sequence, { from: 'orders', to: 'cache' })).toBe('reads from');
    expect(defaultMessageLabel(sequence, { from: 'orders', to: 'events' })).toBe('publishes to');
    expect(defaultMessageLabel(sequence, { from: 'db', to: 'orders', kind: 'reply' })).toBe('');
    expect(defaultMessageLabel(sequence, { from: 'orders', to: 'orders' })).toBe('');
  });

  it('offers only words somebody already wrote: a connector between the linked shapes, what was said before', () => {
    const linked: DraftSequence = { ...messaging, participants: [who('orders', { ref: 'n_orders' }), who('events', { type: 'queue', queueKind: 'topic', ref: 'n_events' }), who('billing')] };
    const edge = createEdge({ source: 'n_orders', target: 'n_events', label: 'OrderPlaced' });
    expect(labelSuggestions(linked, { from: 'orders', to: 'events' }, [edge])).toEqual(['OrderPlaced', 'publish']);
    // Not linked to shapes: the connector says nothing about these two.
    expect(labelSuggestions(messaging, { from: 'orders', to: 'events' }, [edge])).toEqual(['publish']);
    // Nothing written down between them, nothing offered.
    expect(labelSuggestions(messaging, { from: 'billing', to: 'events' }, [edge])).toEqual([]);
  });

  it('after a call: the reply first between two services, the onward call first from a person', () => {
    const services: DraftSequence = { participants: [who('a'), who('b'), who('c')], items: [call('m', 'a', 'b')] };
    expect(nextMessages(services, 'm').map((offer) => offer.title)).toEqual(['Reply to a', 'b calls c', 'b does something itself']);
    // Already answered: only what the receiver might do next.
    expect(nextMessages(three(), 'get').map((offer) => offer.kind)).toEqual(['sync', 'sync']);
    const fresh: DraftSequence = { ...three(), items: [call('get', 'client', 'api')] };
    expect(nextMessages(fresh, 'get').map((offer) => offer.title)).toEqual(['api calls db', 'Reply to client', 'api does something itself']);
  });

  it('after a reply: the answer still owed to whoever is waiting', () => {
    const sequence: DraftSequence = { ...three(), items: three().items.slice(0, 3) };
    expect(nextMessages(sequence, 'rows')).toMatchObject([{ from: 'api', to: 'client', kind: 'reply', replyTo: 'get' }]);
    expect(nextMessages(three(), 'ok')).toEqual([]);
  });

  it('from a participant: its neighbours, then itself', () => {
    expect(nextFromParticipant(three(), 'api').map((offer) => offer.to)).toEqual(['db', 'client', 'api']);
  });
});

describe('naming a new participant', () => {
  const empty: DraftSequence = { participants: [], items: [] };
  const preferred = (query: string, nodes = [] as ReturnType<typeof createNode>[], sequence = empty) => {
    const { options, preferred: at } = participantOptions(query, nodes, sequence);
    return options[at]!;
  };

  it('reads the name the way the shape picker does', () => {
    expect(preferred('Client').participant).toMatchObject({ name: 'Client', type: 'actor' });
    expect(preferred('Database').participant).toMatchObject({ name: 'Database', type: 'database' });
    expect(preferred('API').participant).toMatchObject({ name: 'API', type: 'service' });
    expect(preferred('Checkout').participant).toMatchObject({ name: 'Checkout', type: 'service' });
  });

  it('always lists every kind, so the guess can be overruled', () => {
    const kinds = participantOptions('Client', [], empty).options.filter((option) => option.key.startsWith('kind:')).map((option) => option.participant.type);
    expect([...kinds].sort()).toEqual(['actor', 'component', 'database', 'queue', 'service']);
  });

  it('knows a technology by name, with the kind it implies', () => {
    expect(preferred('Kafka').participant).toMatchObject({ type: 'queue', queueKind: 'topic', technology: 'Apache Kafka' });
    expect(preferred('PostgreSQL').participant).toMatchObject({ type: 'database', technology: 'PostgreSQL' });
  });

  it('prefers the shape already on the canvas by that name, linked — and never the same one twice', () => {
    const shape = createNode({ type: 'database', x: 0, y: 0, text: 'Orders', databaseKind: 'sql', technology: 'PostgreSQL' });
    const picked = preferred('orders', [shape]);
    expect(picked.participant).toMatchObject({ name: 'Orders', type: 'database', databaseKind: 'sql', technology: 'PostgreSQL', ref: shape.id });
    const already: DraftSequence = { participants: [who('o', { ref: shape.id })], items: [] };
    expect(participantOptions('orders', [shape], already).options.some((option) => option.key.startsWith('shape:'))).toBe(false);
  });
});

describe('in the editor', () => {
  const editor = () => useEditorStore.getState();
  let nodeId = '';
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: createDocument('Sequences'),
      path: [],
      outer: null,
      liveViewport: null,
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
      mode: 'edit',
      flowPlayback: { active: false, flowId: null, step: 0 },
      focus: { active: false, nodeIds: [], edgeIds: [] },
      selectedFlowId: null,
    });
    useUiStore.setState({ sequenceFocus: null, sequenceEdit: null });
    nodeId = editor().addNode({ type: 'sequence', x: 0, y: 0 }).id;
    for (const name of ['client', 'api', 'db']) sequenceActions.addParticipant(nodeId, { name, type: 'service' });
  });
  const ids = () => sequenceIn(nodeId)!.participants.map((participant) => participant.id);

  it('drawing a message and naming it is one undo step', () => {
    const [client, api] = ids();
    const steps = editor().history.past.length;
    const id = sequenceActions.addMessage(nodeId, { from: client!, to: api! }, { operandId: null, index: 0 })!;
    expect(useUiStore.getState().sequenceEdit).toMatchObject({ target: { kind: 'message', id }, fresh: 'Add message' });
    expect(messagesOf(sequenceIn(nodeId)!)[0]?.label).toBe('calls');
    sequenceActions.setLabel(nodeId, id, 'GET /cart');
    sequenceActions.edit(nodeId, null);
    expect(editor().history.past.length).toBe(steps + 1);
    editor().undo();
    expect(sequenceIn(nodeId)!.items).toHaveLength(0);
    editor().redo();
    expect(messagesOf(sequenceIn(nodeId)!)[0]).toMatchObject({ label: 'GET /cart' });
  });

  it('what was just made is selected without an inspector; picking it opens one', () => {
    const [client, api] = ids();
    const id = sequenceActions.addMessage(nodeId, { from: client!, to: api! }, { operandId: null, index: 0 }, false)!;
    expect(useUiStore.getState().sequenceFocus).toEqual({ nodeId, kind: 'item', ids: [id], quiet: true });
    sequenceActions.select(nodeId, 'item', [id]);
    expect(useUiStore.getState().sequenceFocus).toEqual({ nodeId, kind: 'item', ids: [id] });
  });

  it('a reply goes below whatever its call set going', () => {
    const [client, api, db] = ids();
    const get = sequenceActions.addMessage(nodeId, { from: client!, to: api! }, { operandId: null, index: 0 }, false)!;
    const select = sequenceActions.addMessage(nodeId, { from: api!, to: db! }, { operandId: null, index: 1 }, false)!;
    const reply = sequenceActions.addReply(nodeId, get)!;
    sequenceActions.edit(nodeId, null);
    expect(messagesOf(sequenceIn(nodeId)!).map((message) => message.id)).toEqual([get, select, reply]);
  });

  it('selecting something else on the canvas lets go of what was selected inside', () => {
    const [client] = ids();
    sequenceActions.select(nodeId, 'participant', [client!]);
    const other = editor().addNode({ type: 'service', x: 900, y: 0 });
    editor().setSelection({ nodes: [other.id], edges: [] });
    expect(useUiStore.getState().sequenceFocus).toBeNull();
  });

  it('undoing the thing that was selected lets go of it too', () => {
    const [client, api] = ids();
    const id = sequenceActions.addMessage(nodeId, { from: client!, to: api! }, { operandId: null, index: 0 }, false)!;
    expect(useUiStore.getState().sequenceFocus?.ids).toEqual([id]);
    editor().undo();
    expect(useUiStore.getState().sequenceFocus).toBeNull();
  });

  it('a read-only diagram refuses every one of them', () => {
    const [client, api] = ids();
    useUiStore.setState({ readOnly: { collaborative: false } as never });
    expect(sequenceActions.addMessage(nodeId, { from: client!, to: api! }, { operandId: null, index: 0 }, false)).toBeNull();
    useUiStore.setState({ readOnly: null });
  });
});
