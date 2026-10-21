import { beforeEach, describe, expect, it } from 'vitest';
import { classify } from '../src/depth/c4';
import { categoryOf, edgeRelationLabel, inferRelationship } from '../src/document/connectorSemantics';
import { shapeKindOf } from '../src/document/shape';
import { createDocument, createNode, displayNameFor } from '../src/document/factory';
import { ACTOR_KINDS, type DraftNode } from '../src/document/types';
import { resolveType, typeWordOf } from '../src/agent/vocabulary';
import { describeContext, describeNode } from '../src/nodes/describe';
import { LIGHT } from '../src/render/theme/tokens';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

describe('actor kinds', () => {
  it('names a fresh actor for its kind', () => {
    expect(createNode({ type: 'actor', x: 0, y: 0 }).text).toBe('User');
    expect(createNode({ type: 'actor', x: 0, y: 0, actorKind: 'agent' }).text).toBe('AI Agent');
    expect(createNode({ type: 'actor', x: 0, y: 0, actorKind: 'group' }).text).toBe('User Group');
    expect(displayNameFor({ type: 'actor', text: '', actorKind: 'agent' })).toBe('AI Agent');
  });

  it('draws every kind with its own glyph', () => {
    const ctx = describeContext(LIGHT);
    const glyphs = ACTOR_KINDS.map((actorKind) =>
      JSON.stringify(describeNode(createNode({ type: 'actor', id: 'a', x: 0, y: 0, actorKind, text: 'Name' }), ctx).shapes),
    );
    expect(new Set(glyphs).size).toBe(ACTOR_KINDS.length);
  });

  it('reads an AI agent as an external software system, and round-trips its agent word', () => {
    const agent = createNode({ type: 'actor', x: 0, y: 0, actorKind: 'agent' });
    expect(classify(agent, { level: 'context' })).toMatchObject({ role: 'software-system', scope: 'external' });
    expect(typeWordOf(agent)).toBe('ai-agent');
    expect(resolveType('ai-agent')).toMatchObject({ type: 'actor', actorKind: 'agent' });
    expect(resolveType('bot')).toMatchObject({ type: 'actor', actorKind: 'agent' });
  });
});

describe('actor label follows its kind', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.getState().setDocument(createDocument('Actor kinds'), { resetHistory: true });
  });

  const nodeOf = (id: string) => useEditorStore.getState().document.nodes.find((n) => n.id === id)!;

  it('renames an unnamed actor on every kind change, and undo restores the name', () => {
    const actor = useEditorStore.getState().addNode({ type: 'actor', x: 0, y: 0 });
    useEditorStore.getState().updateNodeById(actor.id, { actorKind: 'agent' }, 'Change actor type');
    expect(nodeOf(actor.id).text).toBe('AI Agent');
    useEditorStore.getState().updateNodeById(actor.id, { actorKind: 'device' }, 'Change actor type');
    expect(nodeOf(actor.id).text).toBe('Device');
    useEditorStore.getState().undo();
    expect(nodeOf(actor.id)).toMatchObject({ actorKind: 'agent', text: 'AI Agent' });
  });

  it('renames an older actor still called by a kind name, even though it was saved as typed', () => {
    const actor = useEditorStore.getState().addNode({ type: 'actor', x: 0, y: 0, text: 'User' });
    expect(actor.textOrigin).toBe('explicit');
    useEditorStore.getState().updateNodeById(actor.id, { actorKind: 'system' }, 'Change actor type');
    expect(nodeOf(actor.id)).toMatchObject({ text: 'System', textOrigin: 'auto' });
  });

  it('keeps a name the user gave', () => {
    const actor = useEditorStore.getState().addNode({ type: 'actor', x: 0, y: 0, text: 'Support Copilot' });
    useEditorStore.getState().updateNodeById(actor.id, { actorKind: 'agent' }, 'Change actor type');
    expect(nodeOf(actor.id).text).toBe('Support Copilot');
  });
});

describe('actor relationships', () => {
  const person = { type: 'actor', actorKind: 'human' } as const;
  const team = { type: 'actor', actorKind: 'group' } as const;
  const agent = { type: 'actor', actorKind: 'agent' } as const;
  const device = { type: 'actor', actorKind: 'device' } as const;
  const service = { type: 'service' } as const;
  const scheduler = { type: 'service', serviceKind: 'scheduler' } as const;
  const database = { type: 'database' } as const;
  const stream = { type: 'queue', queueKind: 'stream' } as const;

  it.each([
    ['a person asks a person', person, team, 'asks'],
    ['a person asks an AI agent', person, agent, 'asks'],
    ['an agent delegates to an agent', agent, agent, 'delegates'],
    ['an agent escalates to a person', agent, person, 'escalates'],
    ['a person uses a device', person, device, 'uses'],
    ['a device notifies a person', device, person, 'notifies'],
    ['a voice assistant asks an agent, through the person row', device, agent, 'asks'],
    ['an agent calls a service, as a person does', agent, service, 'calls'],
    ['an agent reads a store directly', agent, database, 'reads'],
    ['a device publishes onto a stream', device, stream, 'publishes'],
    ['a service notifies a person', service, person, 'notifies'],
    ['a service notifies a device', service, device, 'notifies'],
    ['a schedule triggers an agent', scheduler, agent, 'triggers'],
  ] as const)('%s', (_, source, target, semantic) => {
    expect(inferRelationship(source, target)?.semantic).toBe(semantic);
  });

  it('leaves a person reaching straight into a store unlabelled', () => {
    expect(inferRelationship(person, database)).toBeUndefined();
  });

  it('keeps every actor kind an Actor in a library thumbnail', () => {
    for (const actorKind of ACTOR_KINDS) expect(shapeKindOf({ type: 'actor', actorKind } as DraftNode)).toBe('actor');
    expect(categoryOf(agent)).toBe('agent');
  });
});

describe('actor connectors follow a kind change', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.getState().setDocument(createDocument('Actor connectors'), { resetHistory: true });
  });

  it('re-reads an inferred connector as either end changes kind, and keeps one the user picked', () => {
    const store = useEditorStore.getState();
    const customer = store.addNode({ type: 'actor', x: 0, y: 0, text: 'Customer' });
    const support = store.addNode({ type: 'actor', x: 300, y: 0, text: 'Support' });
    const edge = store.connect(customer.id, support.id)!;
    const caption = () => {
      const { document } = useEditorStore.getState();
      return edgeRelationLabel(document, document.edges.find((e) => e.id === edge.id)!);
    };
    expect(caption()).toBe('asks');
    store.updateNodeById(customer.id, { actorKind: 'agent' }, 'Change actor type');
    expect(caption()).toBe('escalates to');
    store.updateNodeById(support.id, { actorKind: 'agent' }, 'Change actor type');
    expect(caption()).toBe('delegates to');
    store.setEdgeSemantic(edge.id, 'asks');
    store.updateNodeById(support.id, { actorKind: 'human' }, 'Change actor type');
    expect(caption()).toBe('asks');
  });
});
