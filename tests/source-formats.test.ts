import mermaid from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { c4PlantUmlSource } from '../src/export/source/c4plantuml';
import { drawioSource } from '../src/export/source/drawio';
import { SOURCE_FORMAT_INFO, SOURCE_FORMATS, sourceFileNameFor, sourceTextFor } from '../src/export/source';
import { mermaidFlowchartSource } from '../src/export/source/mermaidFlowchart';
import { structurizrSource } from '../src/export/source/structurizr';
import { ARCHITECTURE_STARTERS } from '../src/starters/catalog';
import { starterDocument } from '../src/starters/document';

/**
 * The architecture source formats are checked against what reads them where a reader is at hand
 * (Mermaid's own parser, an XML parser for draw.io) and against their grammar's shape where none is
 * (balanced blocks and declared-before-used identifiers for C4-PlantUML and Structurizr). Every
 * starter goes through every format, and so does a corpus of the text that breaks generated
 * source: keywords as names, quotes and brackets in labels, a directive planted in a title, markup.
 */

/** Text that has broken a generated diagram somewhere: every delimiter and keyword a format reads. */
const HOSTILE_LABELS = [
  'end',
  'subgraph',
  'style',
  'class',
  'graph',
  'x',
  'o',
  'workspace',
  'model',
  'views',
  'Map<String, Order>',
  'retry(); # then',
  'a "quoted" [bracketed] (paren) {brace} |piped| name',
  '100% %%{init: {"theme": "forest"}}%% done',
  'back\\slash and $variable and ~tilde~',
  '**bold** --strike-- __under__',
  'two\nlines',
  'end note',
  '<b>tag</b> & ampersand',
  '',
];

function hostileDocument(): DraftDocument {
  const types: DraftNode['type'][] = ['service', 'database', 'queue', 'actor', 'component'];
  const nodes = HOSTILE_LABELS.map((text, index) =>
    createNode({ type: types[index % types.length]!, x: index * 200, y: (index % 3) * 150, text, description: text, technology: text }),
  );
  const boundary = createNode({ type: 'group', x: -50, y: -50, width: 3000, height: 600, text: 'end', boundaryPreset: 'system' });
  nodes.slice(0, 4).forEach((node) => (node.parentId = boundary.id));
  const junction = createNode({ type: 'ellipse', x: 100, y: 500 });
  const note = createNode({ type: 'note', x: 0, y: 700, text: 'a note' });
  const edges = nodes.slice(1).map((node, index) =>
    createEdge({ source: nodes[index]!.id, target: node.id, label: HOSTILE_LABELS[(index + 3) % HOSTILE_LABELS.length], directed: index % 2 === 0, async: index % 3 === 0 }),
  );
  edges.push(createEdge({ source: nodes[0]!.id, target: junction.id }), createEdge({ source: junction.id, target: nodes[5]!.id, semantic: 'http' }));
  // `createEdge` keeps `hasResponse` but not the reply text itself; a saved file carries both.
  edges.push({ ...createEdge({ source: nodes[2]!.id, target: nodes[7]!.id, semantic: 'reads', condition: 'if "quoted"', hasResponse: true }), response: '200 <ok>' });
  const document = { ...createDocument('Hostile %%{init: {}}%% "title" <x>'), nodes: [boundary, ...nodes, junction, note], edges };
  // A room inside a shape, so every format has to walk the tree.
  const inner = createNode({ type: 'component', x: 0, y: 0, text: 'subgraph' });
  const innerStore = createNode({ type: 'database', x: 300, y: 0, text: 'views' });
  nodes[0]!.inside = {
    nodes: [inner, innerStore],
    edges: [createEdge({ source: inner.id, target: innerStore.id, semantic: 'writes' })],
    flows: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    level: 'component',
  };
  return document;
}

const starters = ARCHITECTURE_STARTERS.map((starter) => [starter.name, starterDocument(starter)] as const);
const corpus = [...starters, ['the hostile corpus', hostileDocument()] as const, ['an empty canvas', createDocument('Empty')] as const];

async function mermaidParses(text: string): Promise<boolean> {
  return (await mermaid.parse(text, { suppressErrors: true })) !== false;
}

describe('Mermaid flowchart', () => {
  beforeAll(() => mermaid.initialize({ startOnLoad: false }));

  it('is a real check: broken text is refused', async () => {
    expect(await mermaidParses('flowchart LR\n    A --> \n')).toBe(false);
  });

  it.each(corpus)('%s parses with Mermaid', async (_name, document) => {
    const text = mermaidFlowchartSource(document);
    expect(text).toContain('flowchart LR');
    expect(text).not.toMatch(/%%\{/);
    expect(await mermaidParses(text)).toBe(true);
  });

  it('draws each kind with its own silhouette and keeps labels, boundaries and rooms', () => {
    const text = mermaidFlowchartSource(hostileDocument());
    expect(text).toMatch(/\[\("/); // cylinder
    expect(text).toMatch(/\[\["/); // queue
    expect(text).toMatch(/\(\("/); // actor
    expect(text).toContain('subgraph');
    expect(text).toContain('#quot;quoted#quot;');
    expect(text).toContain('Map#lt;String, Order#gt;');
    expect(text).toContain('subgraph Room1[');
    expect(text).toMatch(/-- "writes to" -->/);
  });
});

describe('C4-PlantUML', () => {
  it.each(corpus)('%s is a balanced diagram with the C4 include', (_name, document) => {
    const text = c4PlantUmlSource(document);
    expect(text.startsWith("' Generated by Draft Canvas")).toBe(true);
    expect(text).toContain('@startuml');
    expect(text).toMatch(/!include <C4\/C4_(Container|Component)>/);
    expect(text.trimEnd().endsWith('@enduml')).toBe(true);
    const opens = (text.match(/\{\s*$/gm) ?? []).length;
    const closes = (text.match(/^\s*\}\s*$/gm) ?? []).length;
    expect(opens).toBe(closes);
    // No raw markup or preprocessor opener survives into a quoted argument.
    for (const line of text.split('\n').filter((l) => /^\s*(Rel|BiRel|Person|System|Container|Component|Boundary)/.test(l))) {
      expect(line).not.toMatch(/"[^"]*[<%~\\$][^"]*"/.source.replace('<', '<(?!U\\+)'));
    }
  });

  it('uses every relationship only between declared aliases', () => {
    const text = c4PlantUmlSource(hostileDocument());
    const declared = new Set([...text.matchAll(/^\s*(?:Person|System|Container|Component)\w*\((\w+),/gm)].map((m) => m[1]));
    for (const [, a, b] of text.matchAll(/^\s*(?:Bi)?Rel\((\w+), (\w+),/gm)) {
      expect(declared.has(a!)).toBe(true);
      expect(declared.has(b!)).toBe(true);
    }
    expect(text).toContain('System_Boundary(');
    expect(text).toContain('Container_Boundary(');
    expect(text).toContain('!include <C4/C4_Component>');
    expect(text).toContain('<U+0022>quoted<U+0022>');
  });
});

describe('Structurizr DSL', () => {
  it.each(corpus)('%s is a balanced workspace', (_name, document) => {
    const text = structurizrSource(document);
    expect(text).toMatch(/^# Generated by Draft Canvas/);
    expect(text).toContain('workspace ');
    expect(text).toContain('model {');
    expect(text).toContain('views {');
    const opens = (text.match(/\{/g) ?? []).length;
    const closes = (text.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('declares every identifier once, before the relationships that use it', () => {
    const text = structurizrSource(hostileDocument());
    const declared = [...text.matchAll(/^\s*(\w+) = (person|softwareSystem|container|component)/gm)].map((m) => m[1]!);
    expect(new Set(declared).size).toBe(declared.length);
    const set = new Set(declared);
    for (const [, a, b] of text.matchAll(/^\s*(\w+) -> (\w+) /gm)) {
      expect(set.has(a!)).toBe(true);
      expect(set.has(b!)).toBe(true);
    }
    expect(text).toContain('group "end" {');
    expect(text).toContain('"a \\"quoted\\" [bracketed] (paren) {brace} |piped| name"');
    // A canvas with data stores and no level reads as a container view, so the room inside a
    // container is its components.
    expect(text).toMatch(/= container "end"[^\n]*\{\n\s+\w+ = component "subgraph"/);
  });

  it('wraps a container view in one system named for the canvas, people outside it', () => {
    const user = createNode({ type: 'actor', x: 0, y: 0, text: 'User' });
    const api = createNode({ type: 'service', x: 200, y: 0, text: 'API' });
    const document = { ...createDocument('Shop'), level: 'container' as const, nodes: [user, api], edges: [createEdge({ source: user.id, target: api.id, label: 'buys' })] };
    const text = structurizrSource(document);
    expect(text).toContain('User = person "User"');
    expect(text).toMatch(/System = softwareSystem "Shop" \{\n\s+API = container "API"/);
    expect(text).toContain('User -> API "buys"');
    expect(text).toContain('container System {');
  });
});

describe('draw.io', () => {
  const parse = (text: string) => new DOMParser().parseFromString(text, 'application/xml');

  it.each(corpus)('%s is well-formed mxGraph XML with one page per room', (_name, document) => {
    const xml = parse(drawioSource(document));
    expect(xml.querySelector('parsererror')).toBeNull();
    expect(xml.documentElement.tagName).toBe('mxfile');
    const pages = xml.querySelectorAll('diagram');
    expect(pages.length).toBeGreaterThanOrEqual(1);
    for (const page of pages) {
      expect(page.querySelector('mxGraphModel > root > mxCell[id="0"]')).not.toBeNull();
      expect(page.querySelector('mxGraphModel > root > mxCell[id="1"]')).not.toBeNull();
    }
  });

  it('writes every shape as a vertex at its canvas position, boundaries as containers, connectors as edges', () => {
    const document = hostileDocument();
    const xml = parse(drawioSource(document));
    const page = xml.querySelector('diagram')!;
    const vertices = [...page.querySelectorAll('mxCell[vertex="1"]')].filter((cell) => !cell.getAttribute('style')?.startsWith('edgeLabel'));
    expect(vertices).toHaveLength(document.nodes.length);
    const edges = page.querySelectorAll('mxCell[edge="1"]');
    expect(edges).toHaveLength(document.edges.length);
    const boundary = document.nodes.find((node) => node.type === 'group')!;
    const container = page.querySelector(`mxCell[id="${boundary.id}"]`)!;
    expect(container.getAttribute('style')).toContain('container=1');
    const member = document.nodes.find((node) => node.parentId === boundary.id)!;
    const cell = page.querySelector(`mxCell[id="${member.id}"]`)!;
    expect(cell.getAttribute('parent')).toBe(boundary.id);
    const geometry = cell.querySelector('mxGeometry')!;
    expect(Number(geometry.getAttribute('x'))).toBe(member.x - boundary.x);
    expect(Number(geometry.getAttribute('width'))).toBe(member.width);
    // A tagged label stays text: the HTML escape survives the XML one.
    const tagged = document.nodes.find((node) => node.text === '<b>tag</b> & ampersand')!;
    expect(page.querySelector(`mxCell[id="${tagged.id}"]`)!.getAttribute('value')).toBe('&lt;b&gt;tag&lt;/b&gt; &amp; ampersand');
    // The second page is the room.
    expect(xml.querySelectorAll('diagram')[1]!.getAttribute('name')).toContain(' / ');
    // Condition and response ride as edge labels on their connector.
    const labelled = page.querySelectorAll('mxCell[style^="edgeLabel"]');
    expect(labelled).toHaveLength(2);
  });
});

describe('the source format table', () => {
  it('names a file for every format and renders each through sourceTextFor', () => {
    const document = starters[0]![1];
    for (const format of SOURCE_FORMATS) {
      expect(sourceFileNameFor(document, format).endsWith(SOURCE_FORMAT_INFO[format].extension)).toBe(true);
      const text = sourceTextFor(document, format);
      expect(text.length).toBeGreaterThan(20);
      expect(sourceTextFor(document, format)).toBe(text);
    }
    expect(sourceTextFor(document, 'mermaid')).toContain('sequenceDiagram');
    expect(sourceTextFor(document, 'mermaid-flowchart')).toContain('flowchart LR');
  });
});
