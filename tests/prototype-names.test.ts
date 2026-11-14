/**
 * Text a person types is data, never a property name. "constructor", "__proto__", "toString" and
 * "hasOwnProperty" used to find Object.prototype's members in lookup tables keyed by that text:
 * a Data Store whose technology was "constructor" got the `Object` function as its kind, and
 * `structuredClone` of the file then threw on every autosave.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveType } from '../src/agent/vocabulary';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { kindForTechnology, shapeForTechnology, technologyKindPatch, technologyStart } from '../src/document/technologyKind';
import { normalizeDocument, parseDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';
import { parseMermaidSequence } from '../src/import/mermaid/sequence';
import { describeContext, describeNode } from '../src/nodes/describe';
import { languageForFence } from '../src/render/code/highlight';
import { renderDocumentSvg } from '../src/render/svg/document';
import { LIGHT } from '../src/render/theme/tokens';
import { __resetInteraction, fileOf, useEditorStore } from '../src/store/editorStore';

const WORDS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
const store = useEditorStore;

describe.each(WORDS)('"%s" as text', (word) => {
  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Words'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('is no technology the table knows', () => {
    for (const type of ['database', 'queue', 'service'] as const) expect(kindForTechnology(type, word)).toBeNull();
    expect(shapeForTechnology(word)).toBeNull();
    expect(technologyStart('database', word)).toEqual({ technology: word });
    expect(technologyKindPatch(createNode({ type: 'database', x: 0, y: 0 }), word)).toBeNull();
  });

  it.each(['database', 'queue', 'service'] as const)('typed as a %s technology leaves a document that structured-clones', (type) => {
    const node = store.getState().addNode({ type, x: 0, y: 0 });
    store.getState().setNodeC4Text(node.id, { technology: word, description: word });
    store.getState().updateNodeById(node.id, { technology: word });
    const file = fileOf(store.getState());
    expect(() => structuredClone(file)).not.toThrow();
    const stored = file.nodes[0]!;
    expect(stored.technology).toBe(word);
    for (const kind of [stored.databaseKind, stored.queueKind, stored.serviceKind]) expect(typeof kind === 'string' || kind === undefined).toBe(true);
  });

  it('survives every text field, the autosave clone, a reload and an export', () => {
    const a = createNode({ type: 'database', x: 0, y: 0, text: word, technology: word, description: word });
    const b = createNode({ type: 'service', x: 300, y: 0, text: word, technology: word });
    const c = createNode({ type: 'queue', x: 600, y: 0, text: `\`\`\`${word}\n${word}\n\`\`\``, technology: word });
    const edge = createEdge({ source: a.id, target: b.id, label: word });
    const doc = addEdges(addNodes(createDocument(word), [a, b, c]), [edge]);
    expect(() => structuredClone(doc)).not.toThrow();
    const reloaded = parseDocument(serializeDocument(doc));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.repairs).toEqual([]);
    expect(reloaded.document.nodes.map((n) => n.text)).toEqual([word, word, `\`\`\`${word}\n${word}\n\`\`\``]);
    expect(() => structuredClone(reloaded.document)).not.toThrow();
    const drawn = renderDocumentSvg(reloaded.document, { theme: 'light' } as never);
    expect(drawn.svg).toContain('<svg');
    for (const node of reloaded.document.nodes) expect(() => describeNode(node, describeContext(LIGHT))).not.toThrow();
  });

  it('is no code language, no element type and no Mermaid keyword', () => {
    expect(languageForFence(word)).toBe('plaintext');
    expect(resolveType(word)).toBeUndefined();
    const read = parseMermaidSequence(`sequenceDiagram\n  participant A\n  ${word}\n  A->>A: #${word};\n`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.stringify(read.sequence)).not.toMatch(/native code|\[object/);
    expect(read.sequence.items.every((item) => item.t !== 'fragment')).toBe(true);
  });
});

describe('a file that already stores such a value', () => {
  it('opens, with the kind read as the default', () => {
    const raw = {
      format: 'draftcanvas',
      version: 20,
      metadata: { id: 'x', title: 'constructor', createdAt: 0, updatedAt: 0 },
      nodes: [
        { id: 'constructor', type: 'database', x: 0, y: 0, width: 160, height: 80, z: 0, text: 'constructor', technology: 'constructor', databaseKind: 'constructor', kindOrigin: 'technology' },
        { id: '__proto__', type: 'queue', x: 300, y: 0, width: 160, height: 80, z: 0, text: '__proto__', technology: '__proto__', queueKind: 'toString' },
        { id: 'toString', type: 'service', x: 600, y: 0, width: 160, height: 80, z: 0, text: 'hasOwnProperty', technology: 'valueOf', serviceKind: '__proto__' },
      ],
      edges: [],
      flows: [],
    };
    const result = normalizeDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes.map((n) => n.id)).toEqual(['constructor', '__proto__', 'toString']);
    expect(result.document.nodes[0]).toMatchObject({ databaseKind: 'generic', technology: 'constructor' });
    expect(result.document.nodes[1]).toMatchObject({ queueKind: 'queue' });
    expect(result.document.nodes[2]).toMatchObject({ serviceKind: 'generic' });
    expect(() => structuredClone(result.document)).not.toThrow();
  });
});
