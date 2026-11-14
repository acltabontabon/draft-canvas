import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes, moveNodes, updateNode } from '../src/document/operations';
import { hasDrifted, participantFromNode, syncLinks } from '../src/document/sequenceLinks';
import { updateParticipant, updateSequence } from '../src/document/sequenceOps';
import type { DraftDocument, DraftNode, SeqParticipant } from '../src/document/types';
import { sequenceCommands, sequenceFromSelectionCommands } from '../src/commands/sequence';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { sequenceActions, sequenceIn } from '../src/store/sequenceActions';
import { useUiStore } from '../src/store/uiStore';
import { stubContext } from './commandStubs';

const api = () => createNode({ id: 'n_api', type: 'service', x: 0, y: 0, text: 'Checkout API', serviceKind: 'api', technology: 'Spring Boot' });
const bus = () => createNode({ id: 'n_bus', type: 'queue', x: 300, y: 0, text: 'Order events', queueKind: 'topic', technology: 'Apache Kafka', kindOrigin: 'technology' });
const store = () => createNode({ id: 'n_db', type: 'database', x: 600, y: 0, text: 'Orders', technology: 'PostgreSQL' });

function linkedDoc(): DraftDocument {
  const shapes = [api(), bus(), store()] as (DraftNode & { type: SeqParticipant['type'] })[];
  const sequence = (id: string) => ({
    ...createNode({ id, type: 'sequence', x: 0, y: 400 }),
    sequence: { participants: shapes.map((shape) => participantFromNode(shape, `sp_${shape.id}`)), items: [] },
  });
  return addNodes(createDocument(), [...shapes, sequence('n_seq'), sequence('n_other')]);
}
const participant = (doc: DraftDocument, sequenceId: string, shapeId: string) =>
  doc.nodes.find((node) => node.id === sequenceId)!.sequence!.participants.find((entry) => entry.ref === shapeId)!;
const shape = (doc: DraftDocument, id: string) => doc.nodes.find((node) => node.id === id)!;

describe('a participant that stands for a shape', () => {
  it('carries the shape’s identity: name, kind, technology', () => {
    expect(participantFromNode(bus() as never, 'p')).toEqual({ id: 'p', name: 'Order events', type: 'queue', queueKind: 'topic', technology: 'Apache Kafka', kindOrigin: 'technology', ref: 'n_bus' });
    expect(participantFromNode(api() as never, 'p')).toMatchObject({ type: 'service', serviceKind: 'api', technology: 'Spring Boot' });
  });

  it('a shape renamed on the canvas renames every participant that stands for it', () => {
    const before = linkedDoc();
    const { doc, shapes } = syncLinks(before, updateNode(before, 'n_api', { text: 'Checkout service' }));
    expect(participant(doc, 'n_seq', 'n_api').name).toBe('Checkout service');
    expect(participant(doc, 'n_other', 'n_api').name).toBe('Checkout service');
    expect(participant(doc, 'n_seq', 'n_bus')).toBe(participant(before, 'n_seq', 'n_bus'));
    expect(shapes).toEqual([]);
  });

  it('a participant renamed in its sequence renames the shape, and through it the others', () => {
    const before = linkedDoc();
    const edited = updateSequence(before, 'n_seq', (sequence) => updateParticipant(sequence, 'sp_n_db', { name: 'Order store', technology: 'MySQL' }));
    const { doc, shapes } = syncLinks(before, edited);
    expect(shape(doc, 'n_db')).toMatchObject({ text: 'Order store', technology: 'MySQL', textOrigin: 'explicit' });
    expect(participant(doc, 'n_other', 'n_db')).toMatchObject({ name: 'Order store', technology: 'MySQL' });
    expect(shapes).toEqual(['n_db']);
    expect(shape(doc, 'n_api')).toBe(shape(before, 'n_api'));
  });

  it('retyping the participant retypes the shape', () => {
    const before = linkedDoc();
    const edited = updateSequence(before, 'n_seq', (sequence) => updateParticipant(sequence, 'sp_n_api', { type: 'component' }));
    const { doc } = syncLinks(before, edited);
    expect(shape(doc, 'n_api').type).toBe('component');
    expect(participant(doc, 'n_other', 'n_api').type).toBe('component');
  });

  it('moving a shape changes nothing about who stands for it', () => {
    const before = linkedDoc();
    expect(syncLinks(before, moveNodes(before, new Map([['n_api', { x: 40, y: 40 }]]))).doc.nodes.find((node) => node.id === 'n_seq')).toBe(before.nodes.find((node) => node.id === 'n_seq'));
  });

  it('an unlinked participant goes its own way', () => {
    const before = updateSequence(linkedDoc(), 'n_seq', (sequence) => updateParticipant(sequence, 'sp_n_api', { ref: undefined }));
    const { doc } = syncLinks(before, updateNode(before, 'n_api', { text: 'Renamed' }));
    expect(doc.nodes.find((node) => node.id === 'n_seq')!.sequence!.participants[0]!.name).toBe('Checkout API');
    expect(participant(doc, 'n_other', 'n_api').name).toBe('Renamed');
  });

  it('knows when the two have come apart some other way', () => {
    const doc = linkedDoc();
    expect(hasDrifted(participant(doc, 'n_seq', 'n_api'), shape(doc, 'n_api'))).toBe(false);
    expect(hasDrifted({ ...participant(doc, 'n_seq', 'n_api'), name: 'Old name' }, shape(doc, 'n_api'))).toBe(true);
    expect(hasDrifted(participant(doc, 'n_seq', 'n_api'), undefined)).toBe(false);
  });

  it('costs nothing where no sequence links to anything', () => {
    const before = addNodes(createDocument(), [api(), store()]);
    const after = updateNode(before, 'n_api', { text: 'Renamed' });
    expect(syncLinks(before, after).doc).toBe(after);
  });
});

describe('in the editor', () => {
  const editor = () => useEditorStore.getState();
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: addNodes(createDocument('Links'), [api(), bus(), store()]),
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
  });

  it('a sequence from selected shapes: linked participants, left to right, no messages, one undo step', () => {
    editor().setSelection({ nodes: ['n_db', 'n_api', 'n_bus'], edges: [] });
    const steps = editor().history.past.length;
    const [command] = sequenceFromSelectionCommands(stubContext());
    expect(command!.title).toBe('Sequence from these');
    command!.run(stubContext());
    const created = editor().document.nodes.find((node) => node.type === 'sequence')!;
    expect(created.sequence!.participants.map((entry) => [entry.name, entry.ref, entry.technology])).toEqual([
      ['Checkout API', 'n_api', 'Spring Boot'],
      ['Order events', 'n_bus', 'Apache Kafka'],
      ['Orders', 'n_db', 'PostgreSQL'],
    ]);
    expect(created.sequence!.items).toEqual([]);
    // Clear of the architecture, which is left exactly as it was.
    expect(created.x).toBeGreaterThan(shape(editor().document, 'n_db').x + shape(editor().document, 'n_db').width);
    expect(editor().history.past.length).toBe(steps + 1);
    editor().undo();
    expect(editor().document.nodes.map((node) => node.id)).toEqual(['n_api', 'n_bus', 'n_db']);
  });

  it('renaming the shape on the canvas and renaming the participant are each one step, and reach both', () => {
    const id = sequenceActions.createFromShapes(['n_api', 'n_db'])!;
    editor().updateNodeText('n_api', 'Checkout');
    expect(sequenceIn(id)!.participants[0]!.name).toBe('Checkout');
    editor().undo();
    expect(sequenceIn(id)!.participants[0]!.name).toBe('Checkout API');
    expect(shape(editor().document, 'n_api').text).toBe('Checkout API');

    const db = sequenceIn(id)!.participants[1]!.id;
    sequenceActions.updateParticipant(id, db, { name: 'Order database with a much longer name than before' }, 'Rename participant');
    const renamed = shape(editor().document, 'n_db');
    expect(renamed.text).toBe('Order database with a much longer name than before');
    // The shape was given room for its new name, as if it had been renamed where it stands.
    expect(renamed.width * renamed.height).toBeGreaterThan(store().width * store().height);
    editor().undo();
    expect(shape(editor().document, 'n_db').text).toBe('Orders');
  });

  it('deleting the shape keeps the participant; unlinking stops the two following each other', () => {
    const id = sequenceActions.createFromShapes(['n_api', 'n_db'])!;
    editor().setSelection({ nodes: ['n_db'], edges: [] });
    editor().deleteSelection();
    expect(sequenceIn(id)!.participants.map((entry) => [entry.name, entry.ref])).toEqual([['Checkout API', 'n_api'], ['Orders', undefined]]);
    sequenceActions.unlink(id, sequenceIn(id)!.participants[0]!.id);
    editor().updateNodeText('n_api', 'Something else');
    expect(sequenceIn(id)!.participants[0]!.name).toBe('Checkout API');
  });

  it('offers to start a sequence from one shape, and the sequence’s own commands inside it', () => {
    editor().setSelection({ nodes: ['n_api'], edges: [] });
    expect(sequenceFromSelectionCommands(stubContext()).map((command) => command.title)).toEqual(['Start a sequence with this']);
    const id = sequenceActions.createFromShapes(['n_api', 'n_db'])!;
    const node = editor().document.nodes.find((entry) => entry.id === id)!;
    expect(sequenceCommands(stubContext(), node).map((command) => command.id)).toEqual(['seq-add-participant', 'seq-add-reference']);
    sequenceActions.select(id, 'participant', [node.sequence!.participants[0]!.id]);
    expect(sequenceCommands(stubContext(), node).map((command) => command.id)).toEqual(['seq-add-participant', 'seq-add-reference', 'seq-rename', 'seq-group', 'seq-delete']);
  });
});
