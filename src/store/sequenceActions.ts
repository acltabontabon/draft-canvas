/**
 * Everything the editor can do to a sequence, as actions.
 *
 * Each is one `apply` — one undo step, refused on a read-only diagram, sized afterwards
 * (`nodes/sequenceFit.ts`) — over a pure operation from `document/sequenceOps.ts`, and each leaves
 * the selection inside the sequence where a person would expect it: on the message just drawn, on
 * the copy just made. Commands, the context menu, the keyboard and the canvas all come through
 * here; none of them touches a sequence's data on its own.
 */
import { createId } from '../document/ids';
import { createEdge } from '../document/factory';
import { categoryOf, inferRelationship } from '../document/connectorSemantics';
import { relationLabel } from '../document/edgeSemantics';
import {
  contains,
  findItem,
  findOperand,
  itemsAt,
  type SeqSlot,
} from '../document/sequenceModel';
import {
  addOperand,
  addParticipant,
  createFragment,
  createMessage,
  createNote,
  createReply,
  duplicateItem,
  groupParticipants,
  insertItem,
  leaveGroup,
  moveItem,
  moveOperand,
  moveParticipant,
  removeItems,
  removeOperand,
  removeParticipant,
  reverseMessage,
  setFragmentOperator,
  setGuard,
  setMessageKind,
  ungroupParticipants,
  unwrapFragment,
  updateGroup,
  updateMessage,
  updateNote,
  updateParticipant,
  updateReference,
  updateSequence,
  wrapItems,
} from '../document/sequenceOps';
import { addEdges, removeElements } from '../document/operations';
import { isLinkable, participantFromNode } from '../document/sequenceLinks';
import type { DraftNode, DraftSequence, SeqMessage, SeqMessageKind, SeqOperator, SeqParticipant } from '../document/types';
import { describeContext, sequenceLayoutFor } from '../nodes/describe';
import { LIGHT } from '../render/theme/tokens';
import { participantIndexAt } from '../sequence/layout';
import type { SequenceFinding } from '../sequence/check';
import { executionsOf } from '../sequence/executions';
import { sequenceFromFlow } from '../sequence/fromFlow';
import { defaultMessageLabel } from '../sequence/suggest';
import { describeSequenceFocus, type SequenceEditTarget, type SequenceFocus } from '../sequence/focus';
import { announce } from '../lib/announce';
import { roomFor, useEditorStore } from './editorStore';
import { nodeIndex } from './selectors';
import { useUiStore } from './uiStore';

type Recipe = (sequence: DraftSequence) => DraftSequence;

/** The sequence a node holds right now, or null when it is not a sequence (or is gone). */
export function sequenceIn(nodeId: string): DraftSequence | null {
  const node = nodeIndex(useEditorStore.getState().document.nodes).get(nodeId);
  return node?.type === 'sequence' ? (node.sequence ?? { participants: [], items: [] }) : null;
}

function run(nodeId: string, label: string, recipe: Recipe, coalesceKey?: string): boolean {
  const before = sequenceIn(nodeId);
  if (!before) return false;
  useEditorStore.getState().apply(label, (doc) => updateSequence(doc, nodeId, recipe), {
    selection: { nodes: [nodeId], edges: [] },
    ...(coalesceKey ? { coalesceKey } : {}),
  });
  return sequenceIn(nodeId) !== before;
}

const select = (nodeId: string, kind: SequenceFocus['kind'], ids: string[], quiet = false): void => {
  useEditorStore.getState().setSelection({ nodes: [nodeId], edges: [] });
  useUiStore.getState().setSequenceFocus(ids.length > 0 ? { nodeId, kind, ids, ...(quiet ? { quiet: true } : {}) } : null);
  const sequence = sequenceIn(nodeId);
  const said = sequence ? describeSequenceFocus(sequence, kind, ids) : '';
  if (said) announce(said);
};

/** Selects what was just made, without opening an inspector over where the next thing goes. */
const selectMade = (nodeId: string, kind: SequenceFocus['kind'], id: string): void => select(nodeId, kind, [id], true);

const edit = (nodeId: string, target: SequenceEditTarget | null): void => {
  useUiStore.getState().setSequenceEdit(target ? { nodeId, target } : null);
};

/**
 * Makes something and opens it for its words, as one undo step: the step stays open until the field
 * closes (`SequenceEditors` ends it), so "draw a message, type what it says" is undone together.
 */
function makeThenName(nodeId: string, label: string, recipe: Recipe, target: SequenceEditTarget, focus: () => void): boolean {
  const editor = useEditorStore.getState();
  editor.beginInteraction(label);
  if (!run(nodeId, label, recipe)) {
    editor.endInteraction(label);
    return false;
  }
  focus();
  useUiStore.getState().setSequenceEdit({ nodeId, target, fresh: label });
  return true;
}

/**
 * Where a call's reply goes: after the last thing its receiver does for it. Worked out from the
 * bars, so a reply added to a call whose receiver went on to call two others lands below them.
 */
function replySlot(sequence: DraftSequence, call: SeqMessage): SeqSlot | null {
  const found = findItem(sequence, call.id);
  if (!found) return null;
  const operandId = found.at.operand?.id ?? null;
  const list = itemsAt(sequence, operandId) ?? [];
  const work = executionsOf(sequence).executions.find((execution) => execution.startId === call.id);
  let index = found.at.index;
  if (work) {
    const last = list.findIndex((item) => contains(item, work.endId));
    if (last > index) index = last;
  }
  return { operandId, index: index + 1 };
}

/**
 * A step left open by `makeThenName` ends when its field does, however that happens — Enter, Escape,
 * a click elsewhere, the selection moving on, the sequence being deleted by someone else. Watched
 * here rather than in the field: every one of those clears `sequenceEdit`, and not all of them
 * unmount anything.
 */
useUiStore.subscribe((state, previous) => {
  const was = previous.sequenceEdit;
  if (was?.fresh && state.sequenceEdit !== was) useEditorStore.getState().endInteraction(was.fresh);
});

/**
 * The place in a sequence a point on the canvas falls on: which sequence (the topmost under the
 * point), and where among its participants. Null on open canvas. What turns "put a shape down
 * here" into "add a participant here" when here is a sequence.
 */
export function sequenceSeatAt(point: { x: number; y: number }): { nodeId: string; index: number } | null {
  let host: DraftNode | undefined;
  for (const node of useEditorStore.getState().document.nodes) {
    if (node.type !== 'sequence') continue;
    if (point.x < node.x || point.x > node.x + node.width || point.y < node.y || point.y > node.y + node.height) continue;
    if (!host || node.z >= host.z) host = node;
  }
  if (!host) return null;
  return { nodeId: host.id, index: participantIndexAt(sequenceLayoutFor(host, describeContext(LIGHT)), point.x - host.x) };
}

/** Clear fields specific to the previous type before applying a participant suggestion. */
const PARTICIPANT_KIND_FIELDS: Partial<Omit<SeqParticipant, 'id'>> = {
  serviceKind: undefined,
  databaseKind: undefined,
  queueKind: undefined,
  deliveryRole: undefined,
  actorKind: undefined,
  componentKind: undefined,
  technology: undefined,
  kindOrigin: undefined,
};

function defaultParticipant(sequence: DraftSequence): Omit<SeqParticipant, 'id'> {
  const names = new Set(sequence.participants.map((entry) => entry.name.trim().toLowerCase()));
  let number = 1;
  while (names.has(`participant ${number}`)) number += 1;
  return { type: 'service', name: `Participant ${number}` };
}

export const sequenceActions = {
  select,
  edit,

  setMessageNumbering(nodeId: string, enabled: boolean): void {
    run(nodeId, enabled ? 'Show message numbers' : 'Hide message numbers', (sequence) => {
      if ((sequence.numberMessages !== false) === enabled) return sequence;
      const { numberMessages: _previous, ...rest } = sequence;
      return enabled ? rest : { ...rest, numberMessages: false };
    });
  },

  connectParticipants(source: { nodeId: string; participantId: string; offset: number }, target: { nodeId: string; participantId: string; offset: number }): void {
    if (source.nodeId === target.nodeId) return;
    const editor = useEditorStore.getState();
    const nodes = nodeIndex(editor.document.nodes);
    const sourceNode = nodes.get(source.nodeId);
    const targetNode = nodes.get(target.nodeId);
    const from = sourceNode?.sequence?.participants.find((participant) => participant.id === source.participantId);
    const to = targetNode?.sequence?.participants.find((participant) => participant.id === target.participantId);
    if (!sourceNode || !targetNode || !from || !to || !roomFor(0, 1)) return;
    const rightward = targetNode.x + targetNode.width / 2 >= sourceNode.x + sourceNode.width / 2;
    const relationship = inferRelationship(from, to);
    const edge = createEdge({
      source: source.nodeId,
      target: target.nodeId,
      sourceAnchor: { side: rightward ? 'right' : 'left', offset: source.offset, participantId: from.id },
      targetAnchor: { side: rightward ? 'left' : 'right', offset: target.offset, participantId: to.id },
      ...relationship,
      label: relationship?.semantic ? relationLabel(relationship.semantic, categoryOf(from), categoryOf(to)) : undefined,
    });
    editor.apply('Connect sequence participants', (doc) => addEdges(doc, [edge]), { selection: { nodes: [], edges: [edge.id] } });
    useUiStore.getState().setQuietEdge(edge.id);
  },

  /* ------------------------------------------------------------- participants -- */

  /** Adds a participant and answers its id, or null when the sequence is full. */
  addParticipant(nodeId: string, participant: Omit<SeqParticipant, 'id'>, index?: number): string | null {
    const id = createId('sp');
    const added = run(nodeId, 'Add participant', (sequence) => addParticipant(sequence, { ...participant, id }, index));
    if (!added) {
      useUiStore.getState().notify('This sequence has as many participants as it can hold.');
      return null;
    }
    selectMade(nodeId, 'participant', id);
    return id;
  },

  addDefaultParticipant(nodeId: string, index?: number): string | null {
    const sequence = sequenceIn(nodeId);
    return sequence ? sequenceActions.addParticipant(nodeId, defaultParticipant(sequence), index) : null;
  },

  /** Drawing past the final lifeline adds its receiver and the message in the same undo step. */
  addMessageToNewParticipant(nodeId: string, from: string, slot: SeqSlot): void {
    if (!sequenceIn(nodeId)) return;
    const id = createId('sp');
    const message = createMessage({ from, to: id });
    const recipe: Recipe = (sequence) => {
      const withParticipant = addParticipant(sequence, { ...defaultParticipant(sequence), id });
      if (withParticipant === sequence) return sequence;
      const withMessage = insertItem(withParticipant, { ...message, label: defaultMessageLabel(withParticipant, message) }, slot);
      return withMessage === withParticipant ? sequence : withMessage;
    };
    if (!makeThenName(nodeId, 'Add participant and message', recipe, { kind: 'message', id: message.id }, () => selectMade(nodeId, 'item', message.id))) {
      useUiStore.getState().notify('There is no room for another participant and message here.');
    }
  },

  chooseParticipant(nodeId: string, id: string, participant: Omit<SeqParticipant, 'id'>): void {
    run(nodeId, 'Edit participant', (sequence) => updateParticipant(sequence, id, { ...PARTICIPANT_KIND_FIELDS, ...participant }));
  },

  /**
   * A shape with nothing connected to it, moved into the sequence: it becomes a participant and is
   * no longer on the canvas. (One that is part of a diagram stays where it is and is stood in for —
   * `addParticipantFromShape`.) Runs inside whatever step is open, so a drop is one undo.
   */
  moveShapeIn(nodeId: string, shapeId: string, index?: number): string | null {
    const id = sequenceActions.addParticipantFromShape(nodeId, shapeId, index);
    if (!id) return null;
    // Deleting the shape drops the link it had to it: what is left is the participant alone.
    useEditorStore.getState().apply('Move into sequence', (doc) => removeElements(doc, [shapeId]), { selection: { nodes: [nodeId], edges: [] } });
    selectMade(nodeId, 'participant', id);
    return id;
  },

  /** Adds the participant that stands for a shape on the canvas, linked to it. */
  addParticipantFromShape(nodeId: string, shapeId: string, index?: number): string | null {
    const shape = nodeIndex(useEditorStore.getState().document.nodes).get(shapeId);
    if (!shape || !isLinkable(shape)) return null;
    const { id: _blank, ...participant } = participantFromNode(shape, '');
    return sequenceActions.addParticipant(nodeId, participant, index);
  },

  /**
   * A new sequence beside the given shapes, with each of them standing in it, left to right as they
   * stand on the canvas. One undo step. Answers the sequence's id.
   */
  createFromShapes(shapeIds: readonly string[]): string | null {
    const editor = useEditorStore.getState();
    const byId = nodeIndex(editor.document.nodes);
    const shapes = shapeIds
      .map((id) => byId.get(id))
      .filter((node): node is NonNullable<typeof node> => !!node && isLinkable(node))
      .sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2) || a.y - b.y);
    if (shapes.length === 0) return null;
    // To the right of everything on the canvas, level with the top of the chosen shapes: clear of
    // whatever the architecture already is.
    const right = Math.max(...editor.document.nodes.map((node) => node.x + node.width));
    const top = Math.min(...shapes.map((node) => node.y));
    editor.beginInteraction('Sequence from selection');
    const created = useEditorStore.getState().addNode({ type: 'sequence', x: Math.round(right + 120), y: Math.round(top) });
    for (const shape of shapes) sequenceActions.addParticipantFromShape(created.id, shape.id);
    useEditorStore.getState().endInteraction('Sequence from selection');
    select(created.id, 'participant', []);
    return created.id;
  },

  /**
   * A Flow drawn as a sequence, beside the diagram: its steps as messages, in the Flow's own order,
   * between participants that still stand for the Flow's shapes. One undo step. Answers the id.
   */
  createFromFlow(flowId: string): string | null {
    const editor = useEditorStore.getState();
    const made = sequenceFromFlow(editor.document, flowId);
    if (!made) {
      useUiStore.getState().notify('That flow has no steps to draw as a sequence yet.');
      return null;
    }
    const right = Math.max(0, ...editor.document.nodes.map((node) => node.x + node.width));
    const top = Math.min(0, ...editor.document.nodes.map((node) => node.y));
    editor.beginInteraction('Sequence from flow');
    const created = useEditorStore.getState().addNode({ type: 'sequence', x: Math.round(right + 120), y: Math.round(top), text: made.title });
    run(created.id, 'Sequence from flow', () => made.sequence);
    useEditorStore.getState().endInteraction('Sequence from flow');
    select(created.id, 'participant', []);
    return created.id;
  },

  /** Stops a participant standing for a shape: from then on the two are changed separately. */
  unlink(nodeId: string, participantId: string): void {
    run(nodeId, 'Unlink from shape', (sequence) => updateParticipant(sequence, participantId, { ref: undefined }));
  },

  /** Makes a participant stand for a shape on the canvas: it takes the shape's name, kind and technology. */
  linkTo(nodeId: string, participantId: string, shapeId: string): void {
    const shape = nodeIndex(useEditorStore.getState().document.nodes).get(shapeId);
    if (!shape || !isLinkable(shape)) return;
    const { id: _blank, ...identity } = participantFromNode(shape, '');
    run(nodeId, 'Link to shape', (sequence) => updateParticipant(sequence, participantId, identity));
  },

  updateParticipant(nodeId: string, id: string, patch: Partial<Omit<SeqParticipant, 'id'>>, label = 'Edit participant'): void {
    run(nodeId, label, (sequence) => updateParticipant(sequence, id, patch), 'name' in patch ? `seq-name:${nodeId}:${id}` : undefined);
  },

  removeParticipants(nodeId: string, ids: readonly string[]): void {
    const removing = new Set(ids);
    useEditorStore.getState().apply(ids.length > 1 ? 'Delete participants' : 'Delete participant', (doc) => {
      const next = updateSequence(doc, nodeId, (sequence) => ids.reduce(removeParticipant, sequence));
      if (next === doc) return doc;
      const edges = doc.edges.filter((edge) =>
        (edge.source === nodeId && edge.sourceAnchor?.participantId && removing.has(edge.sourceAnchor.participantId)) ||
        (edge.target === nodeId && edge.targetAnchor?.participantId && removing.has(edge.targetAnchor.participantId)),
      );
      return removeElements(next, [], edges.map((edge) => edge.id));
    }, { selection: { nodes: [nodeId], edges: [] } });
  },

  moveParticipant(nodeId: string, id: string, toIndex: number): void {
    run(nodeId, 'Move participant', (sequence) => moveParticipant(sequence, id, toIndex), `seq-order:${nodeId}:${id}`);
  },

  groupParticipants(nodeId: string, ids: readonly string[]): void {
    const id = createId('sg');
    if (!run(nodeId, 'Group participants', (sequence) => groupParticipants(sequence, ids, { id, name: 'Group' }))) return;
    select(nodeId, 'group', [id]);
    edit(nodeId, { kind: 'group', id });
  },

  renameGroup(nodeId: string, groupId: string, name: string): void {
    run(nodeId, 'Rename group', (sequence) => updateGroup(sequence, groupId, { name }));
  },

  ungroup(nodeId: string, groupId: string): void {
    run(nodeId, 'Ungroup participants', (sequence) => ungroupParticipants(sequence, groupId));
  },

  leaveGroup(nodeId: string, participantId: string): void {
    run(nodeId, 'Take out of group', (sequence) => leaveGroup(sequence, participantId));
  },

  /* ----------------------------------------------------------------- messages -- */

  /** Adds a message at a slot, selects it and opens it for its words. Answers its id. */
  addMessage(nodeId: string, input: { from: string; to: string; kind?: SeqMessageKind; label?: string; replyTo?: string }, slot: SeqSlot, thenEdit = true): string | null {
    const sequence = sequenceIn(nodeId);
    if (!sequence) return null;
    const message = createMessage({ ...input, label: input.label ?? defaultMessageLabel(sequence, input) });
    const add: Recipe = (sequence) => insertItem(sequence, message, slot);
    const focus = () => selectMade(nodeId, 'item', message.id);
    if (thenEdit) return makeThenName(nodeId, 'Add message', add, { kind: 'message', id: message.id }, focus) ? message.id : null;
    if (!run(nodeId, 'Add message', add)) return null;
    focus();
    return message.id;
  },

  /** Adds the reply to a call, below whatever the call set going. */
  addReply(nodeId: string, callId: string): string | null {
    const sequence = sequenceIn(nodeId);
    const call = sequence ? findItem(sequence, callId)?.item : null;
    if (!sequence || !call || call.t !== 'message') return null;
    const slot = replySlot(sequence, call);
    if (!slot) return null;
    const reply = createReply(call);
    const made = makeThenName(nodeId, 'Add reply', (current) => insertItem(current, reply, slot), { kind: 'message', id: reply.id }, () => selectMade(nodeId, 'item', reply.id));
    return made ? reply.id : null;
  },

  setLabel(nodeId: string, id: string, label: string): void {
    run(nodeId, 'Edit message', (sequence) => updateMessage(sequence, id, { label }), `seq-label:${nodeId}:${id}`);
  },

  setKind(nodeId: string, id: string, kind: SeqMessageKind): void {
    run(nodeId, 'Change message kind', (sequence) => setMessageKind(sequence, id, kind));
  },

  setEnds(nodeId: string, id: string, ends: { from?: string; to?: string }): void {
    run(nodeId, 'Change who it is between', (sequence) => updateMessage(sequence, id, ends));
  },

  reverse(nodeId: string, id: string): void {
    run(nodeId, 'Reverse message', (sequence) => reverseMessage(sequence, id));
  },

  /** Whether the receiver starts working when this arrives. */
  setActivates(nodeId: string, id: string, on: boolean): void {
    run(nodeId, on ? 'Start work here' : 'Start no work here', (sequence) => updateMessage(sequence, id, { activate: on ? true : undefined }));
  },

  /** Whether the sender's work ends as this leaves. */
  setDeactivates(nodeId: string, id: string, on: boolean): void {
    run(nodeId, on ? 'End work here' : 'End no work here', (sequence) => updateMessage(sequence, id, { deactivate: on ? true : undefined }));
  },

  /* -------------------------------------------------------------------- notes -- */

  addNote(nodeId: string, over: readonly string[], slot: SeqSlot): string | null {
    const note = createNote({ over });
    const made = makeThenName(nodeId, 'Add note', (sequence) => insertItem(sequence, note, slot), { kind: 'note', id: note.id }, () => selectMade(nodeId, 'item', note.id));
    return made ? note.id : null;
  },

  setNoteText(nodeId: string, id: string, text: string): void {
    run(nodeId, 'Edit note', (sequence) => updateNote(sequence, id, { text }), `seq-note:${nodeId}:${id}`);
  },

  /* ---------------------------------------------------------------- fragments -- */

  /** Wraps a stretch of items in a fragment and opens its condition for typing. */
  wrap(nodeId: string, ids: readonly string[], operator: Exclude<SeqOperator, 'ref'>): string | null {
    const id = createId('sf');
    if (!run(nodeId, 'Wrap in fragment', (sequence) => wrapItems(sequence, ids, { id, operator }))) {
      useUiStore.getState().notify('These cannot be wrapped together: pick messages that follow one another.');
      return null;
    }
    select(nodeId, 'item', [id]);
    const fragment = sequenceIn(nodeId) ? findItem(sequenceIn(nodeId)!, id)?.item : null;
    // Every kind but `par` and `critical` is read by its condition, so that is asked for at once.
    if (fragment?.t === 'fragment' && operator !== 'par' && operator !== 'critical' && fragment.operands[0]) {
      edit(nodeId, { kind: 'guard', id: fragment.operands[0].id });
    }
    return id;
  },

  /** Adds a reference to another interaction, covering the given participants. */
  addReference(nodeId: string, covers: readonly string[], slot: SeqSlot): string | null {
    const fragment = createFragment({ operator: 'ref', covers });
    const made = makeThenName(nodeId, 'Add reference', (sequence) => insertItem(sequence, fragment, slot), { kind: 'reference', id: fragment.id }, () => select(nodeId, 'item', [fragment.id]));
    return made ? fragment.id : null;
  },

  setReferenceLabel(nodeId: string, id: string, label: string): void {
    run(nodeId, 'Edit reference', (sequence) => updateReference(sequence, id, { label }));
  },

  unwrap(nodeId: string, id: string): void {
    if (run(nodeId, 'Unwrap', (sequence) => unwrapFragment(sequence, id))) select(nodeId, 'item', []);
  },

  setOperator(nodeId: string, id: string, operator: SeqOperator): void {
    run(nodeId, 'Change fragment kind', (sequence) => setFragmentOperator(sequence, id, operator));
  },

  setGuard(nodeId: string, operandId: string, guard: string): void {
    run(nodeId, 'Edit condition', (sequence) => setGuard(sequence, operandId, guard), `seq-guard:${nodeId}:${operandId}`);
  },

  /** Adds a branch after `afterOperandId` (or last) and opens its condition. */
  addBranch(nodeId: string, fragmentId: string, afterOperandId?: string): string | null {
    const id = createId('so');
    if (!run(nodeId, 'Add branch', (sequence) => addOperand(sequence, fragmentId, { id }, afterOperandId))) return null;
    select(nodeId, 'operand', [id]);
    const fragment = findItem(sequenceIn(nodeId)!, fragmentId)?.item;
    if (fragment?.t === 'fragment' && fragment.operator === 'alt') edit(nodeId, { kind: 'guard', id });
    return id;
  },

  removeBranch(nodeId: string, operandId: string, withContents = false): void {
    if (run(nodeId, 'Remove branch', (sequence) => removeOperand(sequence, operandId, withContents))) select(nodeId, 'operand', []);
  },

  moveBranch(nodeId: string, operandId: string, by: 1 | -1): void {
    const found = sequenceIn(nodeId) ? findOperand(sequenceIn(nodeId)!, operandId) : null;
    if (!found) return;
    run(nodeId, 'Move branch', (sequence) => moveOperand(sequence, operandId, found.index + by));
  },

  /* ---------------------------------------------------------------- any item -- */

  moveItem(nodeId: string, id: string, slot: SeqSlot): void {
    run(nodeId, 'Move', (sequence) => moveItem(sequence, id, slot), `seq-move:${nodeId}:${id}`);
  },

  /** Deletes items outright, with whatever is inside them. */
  removeItems(nodeId: string, ids: readonly string[]): void {
    if (run(nodeId, 'Delete', (sequence) => removeItems(sequence, ids))) select(nodeId, 'item', []);
  },

  duplicate(nodeId: string, id: string): void {
    let copy: string | null = null;
    const done = run(nodeId, 'Duplicate', (sequence) => {
      const result = duplicateItem(sequence, id);
      copy = result.id;
      return result.sequence;
    });
    if (done && copy) selectMade(nodeId, 'item', copy);
  },

  /** Applies the fix a finding offers. */
  applyFix(nodeId: string, finding: SequenceFinding): void {
    const fix = finding.fix;
    if (fix) run(nodeId, fix.label, fix.apply);
  },
};
