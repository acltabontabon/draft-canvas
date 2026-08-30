import { beforeEach, describe, expect, it } from 'vitest';
import { resolveEdgeColor } from '../src/edges/kindStyle';
import { themeFor } from '../src/render/theme/tokens';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { selectEdge, selectNode } from '../src/store/selectors';

const theme = themeFor('light');

describe('resolveEdgeColor', () => {
  it('falls back to the plain connector grey when neither the edge nor the source has an accent', () => {
    expect(resolveEdgeColor({ accent: undefined }, undefined, theme)).toBe(theme.edge);
    expect(resolveEdgeColor({ accent: undefined }, { accent: undefined }, theme)).toBe(theme.edge);
  });

  it('falls back to grey for an explicitly neutral edge accent', () => {
    expect(resolveEdgeColor({ accent: 'neutral' }, { accent: 'teal' }, theme)).toBe(theme.edge);
  });

  it('derives a muted colour from the source node when the edge has no explicit accent', () => {
    const color = resolveEdgeColor({ accent: undefined }, { accent: 'teal' }, theme);
    expect(color).toBe(theme.accents.teal.line);
    expect(color).not.toBe(theme.accents.teal.chip);
  });

  it('uses the vivid chip tone for an explicit edge accent, ignoring the source', () => {
    const color = resolveEdgeColor({ accent: 'rose' }, { accent: 'teal' }, theme);
    expect(color).toBe(theme.accents.rose.chip);
  });

  it('falls back to grey for a neutral/absent source when the edge also has none', () => {
    expect(resolveEdgeColor({ accent: undefined }, { accent: 'neutral' }, theme)).toBe(theme.edge);
  });
});

describe('automatic colour follows the source node, live', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Colour'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  function colorOf(edgeId: string) {
    const doc = store.getState().document;
    const edge = selectEdge(doc, edgeId)!;
    const source = selectNode(doc, edge.source);
    return resolveEdgeColor(edge, source, theme);
  }

  it('changes when the source node is recoloured', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0, accent: 'teal' });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    expect(colorOf(edge.id)).toBe(theme.accents.teal.line);

    store.getState().updateNodeById(a.id, { accent: 'violet' });
    expect(colorOf(edge.id)).toBe(theme.accents.violet.line);
  });

  it('changes when the connector is reconnected to a different-coloured source', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0, accent: 'teal' });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const c = store.getState().addNode({ type: 'service', x: 600, y: 0, accent: 'amber' });
    const edge = store.getState().connect(a.id, b.id)!;
    expect(colorOf(edge.id)).toBe(theme.accents.teal.line);

    store.getState().reconnectEdge(edge.id, 'source', c.id, undefined);
    expect(colorOf(edge.id)).toBe(theme.accents.amber.line);
  });

  it('keeps an explicit edge colour through a reconnection to a different source', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0, accent: 'teal' });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const c = store.getState().addNode({ type: 'service', x: 600, y: 0, accent: 'amber' });
    const edge = store.getState().connect(a.id, b.id)!;
    store.getState().updateEdgeById(edge.id, { accent: 'rose' });

    store.getState().reconnectEdge(edge.id, 'source', c.id, undefined);
    expect(colorOf(edge.id)).toBe(theme.accents.rose.chip);
  });
});
