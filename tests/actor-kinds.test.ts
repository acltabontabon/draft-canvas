import { beforeEach, describe, expect, it } from 'vitest';
import { classify } from '../src/depth/c4';
import { createDocument, createNode, displayNameFor } from '../src/document/factory';
import { ACTOR_KINDS } from '../src/document/types';
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
