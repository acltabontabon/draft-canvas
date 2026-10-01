import { describe, expect, it } from 'vitest';
import { AGENT_LIMITS } from '../src/agent/input';
import { parseDocument } from '../src/document/validate';
import { importMermaid, looksLikeMermaid, MERMAID_LIMITS, parseMermaidFlowchart } from '../src/import/mermaid';
import { unsupportedNotice } from '../src/import/route';

/**
 * The Mermaid reader: every shape bracket, every arrow, labels in both spellings, subgraphs, the
 * lines it ignores on purpose — and the hostile input it refuses. Each case asserts the agent
 * payload the flowchart becomes, which is the contract `compose` lays out.
 */

function parsed(text: string) {
  const result = parseMermaidFlowchart(text);
  expect(result.ok, result.ok ? '' : result.error).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result;
}

const byLabel = (result: ReturnType<typeof parsed>, label: string) => {
  const node = result.create.nodes.find((n) => n.label === label);
  expect(node, `no shape labelled ${label}`).toBeDefined();
  return node!;
};

const edge = (result: ReturnType<typeof parsed>, from: string, to: string) => {
  const a = byLabel(result, from).id;
  const b = byLabel(result, to).id;
  const found = result.create.relationships.find((r) => r.from === a && r.to === b);
  expect(found, `no arrow ${from} -> ${to}`).toBeDefined();
  return found!;
};

describe('parseMermaidFlowchart — shapes', () => {
  it('maps every bracket to the element type nearest its meaning', () => {
    const result = parsed(`flowchart TD
      rect[Rect]
      round(Round)
      stadium([Stadium])
      sub[[Subroutine]]
      cyl[(Cylinder)]
      circ((Circle))
      dbl(((Double)))
      rhom{Rhombus}
      hex{{Hexagon}}
      asym>Asymmetric]
      para[/Parallelogram/]
      paraAlt[\\Parallelogram alt\\]
      trap[/Trapezoid\\]
      trapAlt[\\Trapezoid alt/]
    `);
    const types = Object.fromEntries(result.create.nodes.map((n) => [n.label, n.type]));
    expect(types).toEqual({
      Rect: 'service',
      Round: 'service',
      Stadium: 'service',
      Subroutine: 'queue',
      Cylinder: 'database',
      Circle: 'person',
      Double: 'person',
      Rhombus: 'junction',
      Hexagon: 'junction',
      Asymmetric: 'service',
      Parallelogram: 'service',
      'Parallelogram alt': 'service',
      Trapezoid: 'service',
      'Trapezoid alt': 'service',
    });
    expect(result.create.nodes.map((n) => n.id)).toEqual(result.create.nodes.map((_, i) => `n${i + 1}`));
    expect(result.unsupported).toEqual([]);
  });

  it('keeps the id as the text of a bare node, and lets a later bracket name it', () => {
    const result = parsed(`graph LR
      A --> B
      B[Billing]
    `);
    expect(result.create.nodes.map((n) => n.label)).toEqual(['A', 'Billing']);
  });

  it('reads quoted labels, <br> line breaks, entities and strips HTML', () => {
    const result = parsed(`flowchart LR
      a["Order (new)"] --> b[Line one<br/>Line two<br>Three]
      c["#quot;Quoted#quot; #35;1"] --> d[<b>Bold</b> text]
    `);
    expect(byLabel(result, 'Order (new)').type).toBe('service');
    expect(byLabel(result, 'Line one\nLine two\nThree')).toBeDefined();
    expect(byLabel(result, '"Quoted" #1')).toBeDefined();
    expect(byLabel(result, 'Bold text')).toBeDefined();
    expect(result.unsupported).toEqual(['HTML in labels (tags removed)']);
  });

  it('shortens labels past the agent limits and says so once', () => {
    const long = 'x'.repeat(200);
    const result = parsed(`flowchart LR\n a[${long}] -->|${long}| b[${long}]`);
    expect(byLabel(result, `${'x'.repeat(MERMAID_LIMITS.labelLength - 1)}…`)).toBeDefined();
    expect(result.create.relationships[0]!.label).toHaveLength(MERMAID_LIMITS.relationshipLabelLength);
    expect(result.unsupported.filter((u) => u.includes('shortened'))).toHaveLength(2);
  });
});

describe('parseMermaidFlowchart — arrows', () => {
  it('chains A --> B --> C into two arrows', () => {
    const result = parsed('flowchart LR\n A --> B --> C');
    expect(result.create.relationships).toEqual([
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
    ]);
  });

  it('fans out and in with &', () => {
    const result = parsed('flowchart LR\n A & B --> C & D');
    const pairs = result.create.relationships.map((r) => `${r.from}>${r.to}`);
    expect(pairs).toEqual(['n1>n3', 'n1>n4', 'n2>n3', 'n2>n4']);
  });

  it('reads labels in the |pipe| and -- text --> spellings, on every arrow kind', () => {
    const result = parsed(`flowchart LR
      A -->|yes| B
      B -- maybe --> C
      C -. later .-> D
      D == bold ==> E
      E -.->|dotted pipe| F
      F ---|flat| G
    `);
    expect(edge(result, 'A', 'B').label).toBe('yes');
    expect(edge(result, 'B', 'C').label).toBe('maybe');
    expect(edge(result, 'C', 'D')).toMatchObject({ label: 'later', async: true });
    expect(edge(result, 'D', 'E').label).toBe('bold');
    expect(edge(result, 'E', 'F')).toMatchObject({ label: 'dotted pipe', async: true });
    expect(edge(result, 'F', 'G')).toMatchObject({ label: 'flat', directed: false });
    expect(result.unsupported).toEqual([]);
  });

  it('knows every arrow form: open lines, dotted, thick, markers, two-headed, long, invisible', () => {
    const result = parsed(`flowchart LR
      A --> B
      A --- C
      A -.-> D
      A ==> E
      A --x F
      A --o G
      A <--> H
      A ---> I
      A -..-> J
      A ~~~ K
      A-->L
    `);
    expect(edge(result, 'A', 'B')).toEqual({ id: 'e1', from: 'n1', to: 'n2' });
    expect(edge(result, 'A', 'C').directed).toBe(false);
    expect(edge(result, 'A', 'D').async).toBe(true);
    expect(edge(result, 'A', 'E')).toEqual({ id: 'e4', from: 'n1', to: 'n5' });
    expect(edge(result, 'A', 'F')).toBeDefined();
    expect(edge(result, 'A', 'G')).toBeDefined();
    expect(edge(result, 'A', 'H')).toBeDefined();
    expect(edge(result, 'A', 'I')).toBeDefined();
    expect(edge(result, 'A', 'J').async).toBe(true);
    expect(edge(result, 'A', 'L')).toBeDefined();
    // The invisible link declares K but draws nothing.
    expect(byLabel(result, 'K')).toBeDefined();
    expect(result.create.relationships.some((r) => r.to === byLabel(result, 'K').id)).toBe(false);
    expect([...result.unsupported].sort()).toEqual([
      'circle and cross arrowheads (drawn as plain arrows)',
      'invisible links (~~~)',
      'two-headed arrows (drawn one way)',
    ]);
  });

  it('reads a one-line graph with semicolons and a shape declared mid-chain', () => {
    const result = parsed('graph LR; A[Start]-->B{Ok?}; B-->|yes|C[(Store)]; B-->|no|A');
    expect(result.create.nodes.map((n) => [n.label, n.type])).toEqual([
      ['Start', 'service'],
      ['Ok?', 'junction'],
      ['Store', 'database'],
    ]);
    expect(result.create.relationships).toHaveLength(3);
  });
});

describe('parseMermaidFlowchart — subgraphs, comments, directions, the ignored', () => {
  it('turns nested subgraphs into groups with parents and members', () => {
    const result = parsed(`flowchart TB
      subgraph platform [Platform]
        subgraph "Edge zone"
          gw[Gateway]
        end
        subgraph core
          api[API] --> db[(DB)]
        end
        gw --> api
      end
      user((User)) --> gw
    `);
    expect(result.create.groups).toEqual([
      { id: 'g1', label: 'Platform', kind: 'group' },
      { id: 'g2', label: 'Edge zone', kind: 'group', parent: 'g1' },
      { id: 'g3', label: 'core', kind: 'group', parent: 'g1' },
    ]);
    expect(byLabel(result, 'Gateway').group).toBe('g2');
    expect(byLabel(result, 'API').group).toBe('g3');
    expect(byLabel(result, 'DB').group).toBe('g3');
    expect(byLabel(result, 'User').group).toBeUndefined();
    expect(result.create.relationships).toHaveLength(3);
  });

  it('skips arrows to a subgraph itself, naming the loss', () => {
    const result = parsed(`flowchart LR
      subgraph one
        a
      end
      b --> one
    `);
    expect(result.create.relationships).toEqual([]);
    expect(result.unsupported).toContain('arrows to or from a subgraph');
  });

  it('ignores %% comments, whole-line and trailing, but not inside a quoted label', () => {
    const result = parsed(`flowchart LR
      %% a whole line
      A --> B %% trailing
      C["100%% sure"] --> D
      %%{init: {'theme': 'dark'}}%%
    `);
    expect(result.create.nodes.map((n) => n.label)).toEqual(['A', 'B', '100%% sure', 'D']);
    expect(result.create.relationships).toHaveLength(2);
  });

  it('reads the flowchart out of a Markdown fence and a title out of front matter', () => {
    const result = parsed(`# Notes

Some prose first.

\`\`\`mermaid
---
title: Checkout path
---
flowchart LR
  A --> B
\`\`\`

More prose with --> arrows that are not a chart.
`);
    expect(result.create.title).toBe('Checkout path');
    expect(result.create.nodes).toHaveLength(2);
  });

  it.each([
    ['flowchart TD', 'down', []],
    ['flowchart TB', 'down', []],
    ['graph LR', 'right', []],
    ['graph RL', 'right', ['direction RL (drawn left to right)']],
    ['graph BT', 'down', ['direction BT (drawn top to bottom)']],
    ['graph', 'down', []],
  ])('%s reads as %s', (header, direction, unsupported) => {
    const result = parsed(`${header}\n A --> B`);
    expect(result.create.layout).toEqual({ direction, allowDegraded: true });
    expect(result.unsupported).toEqual(unsupported);
  });

  it('lists the styling and scripting lines it does not draw, once each', () => {
    const result = parsed(`flowchart LR
      A:::hot --> B
      classDef hot fill:#f96
      class B hot
      style A stroke:#333
      linkStyle 0 stroke:red
      click A callback "Tooltip"
      subgraph s
        direction RL
        C
      end
      classDef cold fill:#69f
    `);
    expect(result.unsupported).toEqual([
      ':::class on a shape',
      'classDef',
      'class',
      'style',
      'linkStyle',
      'click',
      'direction inside a subgraph',
    ]);
    expect(result.create.nodes.map((n) => n.label)).toEqual(['A', 'B', 'C']);
  });
});

describe('parseMermaidFlowchart — refusals', () => {
  it('refuses a hostile chart with 10,000 shapes in one clear sentence', () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `n${i} --> n${i + 1}`);
    const result = parseMermaidFlowchart(`flowchart LR\n${lines.join('\n')}`);
    expect(result).toEqual({ ok: false, error: 'This flowchart has more than 300 shapes; Draft Canvas imports up to 300 at a time.' });
  });

  it('refuses more arrows than one request may carry', () => {
    const lines = Array.from({ length: 700 }, (_, i) => `a${i % 10} --> b${i % 20}`);
    const result = parseMermaidFlowchart(`flowchart LR\n${lines.join('\n')}`);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('more than 600 arrows') });
  });

  it('refuses text past the size cap before reading a line of it', () => {
    const result = parseMermaidFlowchart(`flowchart LR\n${'A --> B\n'.repeat(100_000)}`);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('KB') });
  });

  it('refuses what is not a flowchart, naming the diagram kind when it knows it', () => {
    expect(parseMermaidFlowchart('sequenceDiagram\n A->>B: hi')).toEqual({ ok: false, error: 'Draft Canvas imports Mermaid flowcharts; that is a sequenceDiagram.' });
    expect(parseMermaidFlowchart('just some text')).toMatchObject({ ok: false, error: expect.stringContaining('not a Mermaid flowchart') });
    expect(parseMermaidFlowchart('')).toMatchObject({ ok: false });
    expect(parseMermaidFlowchart('flowchart LR\n %% nothing')).toEqual({ ok: false, error: 'That flowchart declares no shapes.' });
  });

  it('keeps its caps equal to the agent request limits', () => {
    expect(MERMAID_LIMITS.nodes).toBe(AGENT_LIMITS.nodesPerRequest);
    expect(MERMAID_LIMITS.relationships).toBe(AGENT_LIMITS.relationshipsPerRequest);
    expect(MERMAID_LIMITS.groups).toBe(AGENT_LIMITS.groupsPerRequest);
    expect(MERMAID_LIMITS.labelLength).toBe(AGENT_LIMITS.labelLength);
    expect(MERMAID_LIMITS.relationshipLabelLength).toBe(AGENT_LIMITS.relationshipLabelLength);
    expect(MERMAID_LIMITS.groupLabelLength).toBe(AGENT_LIMITS.groupLabelLength);
  });
});

describe('looksLikeMermaid', () => {
  it('recognises a flowchart, fenced or bare, and nothing else', () => {
    expect(looksLikeMermaid('flowchart TD\n A --> B')).toBe(true);
    expect(looksLikeMermaid('  %% comment\ngraph LR; A-->B')).toBe(true);
    expect(looksLikeMermaid('text\n```mermaid\ngraph TD\nA\n```')).toBe(true);
    expect(looksLikeMermaid('---\ntitle: T\n---\nflowchart LR\nA')).toBe(true);
    expect(looksLikeMermaid('sequenceDiagram\n A->>B: hi')).toBe(false);
    expect(looksLikeMermaid('{"format":"draft-canvas"}')).toBe(false);
    expect(looksLikeMermaid('graphics are nice')).toBe(false);
    expect(looksLikeMermaid('')).toBe(false);
  });
});

describe('importMermaid', () => {
  it('lays a flowchart out as a document the file reader accepts, groups as boundaries', async () => {
    const result = await importMermaid(
      `flowchart LR
        user((Customer)) -->|places order| api[Order API]
        subgraph backend [Backend]
          api --> q[[Order queue]]
          q -.-> worker[Fulfilment worker]
          worker --> db[(Orders)]
        end
        classDef x fill:#fff
      `,
      'orders',
    );
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    const read = parseDocument(JSON.parse(JSON.stringify(result.document)));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.repairs).toEqual([]);
    expect(result.document.metadata.title).toBe('orders');
    const shapes = result.document.nodes.filter((n) => n.type !== 'group');
    const boundaries = result.document.nodes.filter((n) => n.type === 'group');
    expect(shapes).toHaveLength(5);
    // A boundary's title is its `text`, the way `agent/place.ts` builds one.
    expect(boundaries.map((b) => b.text)).toEqual(['Backend']);
    expect(shapes.filter((n) => n.parentId === boundaries[0]!.id).map((n) => n.text).sort()).toEqual(['Fulfilment worker', 'Order API', 'Order queue', 'Orders']);
    expect(result.document.edges).toHaveLength(4);
    expect(result.document.edges.find((e) => e.label === 'places order')).toBeDefined();
    expect(result.unsupported).toEqual(['classDef']);
    expect(result.legibility).toBeDefined();
  });

  it('passes a parse error straight through', async () => {
    const result = await importMermaid('pie\n "a": 1');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('pie') });
  });
});

describe('unsupportedNotice', () => {
  it('names what was left out, in one sentence, and nothing when nothing was', () => {
    expect(unsupportedNotice([])).toBeNull();
    expect(unsupportedNotice(['classDef'])).toBe("Imported — 1 thing Mermaid said that Draft Canvas doesn't draw: classDef.");
    expect(unsupportedNotice(['a', 'b', 'c', 'd', 'e', 'f'])).toBe("Imported — 6 things Mermaid said that Draft Canvas doesn't draw: a, b, c, d, and 2 more.");
  });
});
