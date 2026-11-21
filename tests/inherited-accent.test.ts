import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { inheritedAccent, withInheritedAccent } from '../src/document/inheritedAccent';
import { addNodes } from '../src/document/operations';
import type { DraftNode } from '../src/document/types';
import { renderDocumentSvg as renderSvg } from '../src/render/svg/document';

/** Colour by boundary: a shape with no accent of its own draws in its boundary's. */
function index(nodes: DraftNode[]) {
  return new Map(nodes.map((node) => [node.id, node] as const));
}

describe('a shape inherits its boundary accent', () => {
  const outer = createNode({ id: 'outer', type: 'group', x: 0, y: 0, width: 600, height: 400, accent: 'blue' });
  const inner = { ...createNode({ id: 'inner', type: 'group', x: 20, y: 40, width: 300, height: 200 }), parentId: 'outer' };
  const service = { ...createNode({ id: 'svc', type: 'service', x: 40, y: 80 }), parentId: 'inner' };

  it('takes the nearest coloured boundary around it', () => {
    expect(inheritedAccent(service, index([outer, inner, service]))).toBe('blue');
    const green = { ...inner, accent: 'green' as const };
    expect(inheritedAccent(service, index([outer, green, service]))).toBe('green');
  });

  it('keeps its own accent, an explicit neutral included', () => {
    const byId = index([outer, inner, service]);
    expect(inheritedAccent({ ...service, accent: 'amber' }, byId)).toBeUndefined();
    expect(inheritedAccent({ ...service, accent: 'neutral' }, byId)).toBeUndefined();
    expect(withInheritedAccent({ ...service, accent: 'neutral' }, byId).accent).toBe('neutral');
  });

  it('is neutral outside a boundary, and inside one with no colour', () => {
    expect(inheritedAccent({ ...service, parentId: undefined }, index([outer]))).toBeUndefined();
    const plain = { ...outer, accent: undefined };
    expect(inheritedAccent(service, index([plain, inner, service]))).toBeUndefined();
    expect(inheritedAccent(service, index([{ ...outer, accent: 'neutral' }, inner, service]))).toBeUndefined();
  });

  it('leaves notes and text as they are, and returns the same shape when nothing is inherited', () => {
    const note = { ...createNode({ id: 'n', type: 'note', x: 40, y: 80 }), parentId: 'outer' };
    const byId = index([outer, note]);
    expect(inheritedAccent(note, byId)).toBeUndefined();
    expect(withInheritedAccent(note, byId)).toBe(note);
  });

  it('survives a cycle in the parents', () => {
    const a = { ...createNode({ id: 'a', type: 'group', x: 0, y: 0 }), parentId: 'b' };
    const b = { ...createNode({ id: 'b', type: 'group', x: 0, y: 0 }), parentId: 'a' };
    expect(inheritedAccent({ ...service, parentId: 'a' }, index([a, b]))).toBeUndefined();
  });

  it('is never stored, and is drawn the same way in an export', () => {
    const doc = addNodes(createDocument('Colour'), [outer, { ...service, parentId: 'outer' }]);
    expect(doc.nodes.find((node) => node.id === 'svc')!.accent).toBeUndefined();
    const inherited = renderSvg(doc, { theme: 'light' }).svg;
    const own = renderSvg({ ...doc, nodes: doc.nodes.map((node) => (node.id === 'svc' ? { ...node, accent: 'blue' as const } : node)) }, { theme: 'light' }).svg;
    const neutral = renderSvg({ ...doc, nodes: doc.nodes.map((node) => (node.id === 'svc' ? { ...node, accent: 'neutral' as const } : node)) }, { theme: 'light' }).svg;
    expect(inherited).toBe(own);
    expect(inherited).not.toBe(neutral);
  });
});
