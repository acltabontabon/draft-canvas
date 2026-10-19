import { beforeEach, describe, expect, it } from 'vitest';
import { emphasisOf } from '../src/canvas/emphasis';
import { agentGhostDiff } from '../src/canvas/agentGhostDiff';
import { createDocument, createNode } from '../src/document/factory';
import { ACTOR_FRAMES, ACTOR_KINDS } from '../src/document/types';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { describeContext, describeNode, naturalArchitectureSize } from '../src/nodes/describe';
import { DARK, LIGHT } from '../src/render/theme/tokens';
import { renderDocumentSvg } from '../src/render/svg/document';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { PERSONALITY_PRESETS } from '../src/ui/personality/usePersonality';

describe('actor frames', () => {
  it('creates borderless actors and keeps an explicit framed choice', () => {
    expect(createNode({ type: 'actor', x: 0, y: 0 }).actorFrame).toBe('borderless');
    expect(createNode({ type: 'actor', x: 0, y: 0, actorFrame: 'framed' }).actorFrame).toBe('framed');
    expect(createNode({ type: 'service', x: 0, y: 0, actorFrame: 'framed' }).actorFrame).toBeUndefined();
  });

  it.each(ACTOR_KINDS)('removes only the %s actor frame in both themes and every drawing style', (actorKind) => {
    for (const theme of [LIGHT, DARK]) {
      for (const preset of PERSONALITY_PRESETS) {
        const framed = createNode({ type: 'actor', id: 'actor', x: 0, y: 0, text: 'Customer', description: 'Places orders', actorKind, actorFrame: 'framed' });
        const borderless = { ...framed, actorFrame: 'borderless' as const };
        const ctx = describeContext(theme, preset);
        const before = describeNode(framed, ctx);
        const after = describeNode(borderless, ctx);
        expect(after.shapes).toEqual(before.shapes.slice(2));
        expect(naturalArchitectureSize(borderless, ctx)).toEqual(naturalArchitectureSize(framed, ctx));
        // Presentation follows the glyph's own contour, with no hidden frame left to glow.
        expect(emphasisOf(after.shapes)).toEqual(emphasisOf(before.shapes.slice(2)));
        expect(emphasisOf(after.shapes).length).toBeGreaterThan(0);
      }
    }
  });

  it.each(ACTOR_FRAMES)('preserves %s through saving, including look-inside rooms and image exports', (actorFrame) => {
    const actor = createNode({ type: 'actor', id: 'actor', x: 0, y: 0, actorFrame, text: 'Customer' });
    const host = createNode({ type: 'service', x: 300, y: 0 });
    host.inside = { nodes: [actor], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const file = { ...createDocument('Actors'), nodes: [actor, host] };
    const read = deserializeDocument(serializeDocument(file));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.error);
    expect(read.document.nodes[0]!.actorFrame).toBe(actorFrame);
    expect(read.document.nodes[1]!.inside!.nodes[0]!.actorFrame).toBe(actorFrame);
    const svg = renderDocumentSvg({ ...file, nodes: [actor] }).svg;
    expect(svg).toContain('Customer');
    expect(svg.includes('rx="10"')).toBe(actorFrame === 'framed');
  });

  it('keeps missing or invalid frame values framed in older files, without adding fields on save', () => {
    const actor = createNode({ type: 'actor', x: 0, y: 0 });
    delete actor.actorFrame;
    const file = { ...createDocument('Legacy actor'), nodes: [actor] };
    const bytes = serializeDocument(file);
    const read = deserializeDocument(bytes);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.error);
    expect(read.document.nodes[0]!.actorFrame).toBeUndefined();
    expect(serializeDocument(read.document)).toBe(bytes);
    const ctx = describeContext(LIGHT);
    expect(describeNode(read.document.nodes[0]!, ctx)).toEqual(describeNode({ ...actor, actorFrame: 'framed' }, ctx));
    const invalid = deserializeDocument(bytes.replace('"actorKind": "human"', '"actorKind": "human", "actorFrame": "invalid"'));
    expect(invalid.ok && invalid.document.nodes[0]!.actorFrame).toBeUndefined();
  });

  it('shows frame-only changes in agent previews', () => {
    const actor = createNode({ type: 'actor', x: 0, y: 0 });
    const framed = { ...actor, actorFrame: 'framed' as const };
    expect(agentGhostDiff({ nodes: [actor], edges: [] }, { nodes: [framed], edges: [] }).modifiedNodes).toEqual([framed]);
  });
});

describe('actor frame history', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.getState().setDocument(createDocument('Actor history'), { resetHistory: true });
  });

  it('undoes and redoes a frame change without moving, resizing or reconnecting the actor', () => {
    const actor = useEditorStore.getState().addNode({ type: 'actor', x: 100, y: 200, text: 'Customer' });
    const target = useEditorStore.getState().addNode({ type: 'service', x: 400, y: 200 });
    useEditorStore.getState().connect(actor.id, target.id);
    const before = useEditorStore.getState().document;
    useEditorStore.getState().updateNodeById(actor.id, { actorFrame: 'framed' }, 'Change actor frame');
    const after = useEditorStore.getState().document;
    expect(after.nodes[0]).toEqual({ ...before.nodes[0], actorFrame: 'framed' });
    expect(after.edges).toBe(before.edges);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().document.nodes[0]!.actorFrame).toBe('borderless');
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().document.nodes[0]!.actorFrame).toBe('framed');
  });
});
