/**
 * A hand-written reader for Mermaid flowcharts — `flowchart TD` / `graph LR` and what they draw —
 * that produces the agent's `create_diagram` payload rather than a document. The agent's pipeline
 * (`agent/input.ts` validates, `agent/compile.ts` lays out) already turns "shapes, relationships,
 * groups, a direction" into a readable diagram; a second layout path for imports would drift from it.
 *
 * Framework-free and dependency-free on purpose: Mermaid's own parser is a Jison grammar with a DOM
 * renderer attached, and what Draft Canvas needs is one list of elements and one of arrows. Anything
 * the grammar says that this diagram cannot draw is kept, named, in `unsupported` — never silently
 * dropped, never a reason to refuse the rest.
 *
 * Input is untrusted (a paste, a dropped file): every list is capped at what one agent request may
 * carry, so a hostile 10k-node file is refused in one pass rather than laid out for a minute.
 */

export interface MermaidElement {
  id: string;
  type: 'service' | 'database' | 'queue' | 'person' | 'junction';
  label: string;
  group?: string;
}

export interface MermaidRelationship {
  id: string;
  from: string;
  to: string;
  label?: string;
  async?: boolean;
  directed?: boolean;
}

export interface MermaidGroup {
  id: string;
  label: string;
  kind: 'group';
  parent?: string;
}

/** The `create_diagram` payload (`agent/input.ts`'s `CreateSpec`, as JSON) a flowchart becomes. */
export interface MermaidCreate {
  title: string;
  nodes: MermaidElement[];
  relationships: MermaidRelationship[];
  groups: MermaidGroup[];
  layout: { direction: 'right' | 'down'; allowDegraded: true };
}

export type MermaidParse = { ok: true; create: MermaidCreate; unsupported: string[] } | { ok: false; error: string };

/** The same bounds as `AGENT_LIMITS` (`agent/input.ts`); `tests/import-mermaid.test.ts` keeps them equal. */
export const MERMAID_LIMITS = {
  nodes: 300,
  relationships: 600,
  groups: 60,
  labelLength: 120,
  relationshipLabelLength: 80,
  groupLabelLength: 80,
  /** Text past this is not a flowchart anyone drew by hand; refused before any line is read. */
  textLength: 512 * 1024,
} as const;

const DIRECTIONS: Record<string, { direction: 'right' | 'down'; note?: string }> = {
  TD: { direction: 'down' },
  TB: { direction: 'down' },
  LR: { direction: 'right' },
  RL: { direction: 'right', note: 'direction RL (drawn left to right)' },
  BT: { direction: 'down', note: 'direction BT (drawn top to bottom)' },
};

const HEADER = /^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?\s*$/i;
const FENCE = /```\s*mermaid[^\n]*\n([\s\S]*?)```/i;
const FRONT_MATTER = /^\s*---\s*\n([\s\S]*?)\n---\s*\n/;
const ID = /^[\p{L}\p{N}_][\p{L}\p{N}_.]*/u;

/** Lines that style, link or script the drawing — Mermaid's, not the diagram's. */
const IGNORED = /^(classDef|class|style|linkStyle|click|accTitle|accDescr|direction)\b/;
const IGNORED_NAMES: Record<string, string> = {
  classDef: 'classDef',
  class: 'class',
  style: 'style',
  linkStyle: 'linkStyle',
  click: 'click',
  accTitle: 'accTitle',
  accDescr: 'accDescr',
  direction: 'direction inside a subgraph',
};

/**
 * Shape brackets, longest opener first so `[[` is never read as `[`. Each maps to the element
 * type whose meaning is closest: a cylinder is a store, a subroutine a queue (a step handled
 * elsewhere), a circle an actor, a rhombus or hexagon a decision — drawn as a junction, the one
 * shape whose job is being where paths split.
 */
const SHAPES: { open: string; close: string; type: MermaidElement['type'] }[] = [
  { open: '(((', close: ')))', type: 'person' },
  { open: '[[', close: ']]', type: 'queue' },
  { open: '[(', close: ')]', type: 'database' },
  { open: '([', close: '])', type: 'service' },
  { open: '[/', close: '/]', type: 'service' },
  { open: '[/', close: '\\]', type: 'service' },
  { open: '[\\', close: '\\]', type: 'service' },
  { open: '[\\', close: '/]', type: 'service' },
  { open: '((', close: '))', type: 'person' },
  { open: '{{', close: '}}', type: 'junction' },
  { open: '[', close: ']', type: 'service' },
  { open: '(', close: ')', type: 'service' },
  { open: '{', close: '}', type: 'junction' },
  { open: '>', close: ']', type: 'service' },
];

// `A -- text --> B` and `A -. text .-> B` and `A == text ==> B`: an opener, words, a closer.
const TEXT_ARROW = /^\s*(<)?(x|o)?(--|-\.|==)\s+(.+?)\s+(-{2,}|\.+-|={2,})(>|x|o)?(?=\s|$|\|)/;
// `-->`, `---`, `-.->`, `==>`, `--x`, `--o`, `<-->`, `~~~` and every longer spelling of each.
const PLAIN_ARROW = /^\s*(<)?(x|o)?(-{2,}|={2,}|-\.+-|~{3,})(>|x|o)?(?=\s|$|\||[\p{L}\p{N}_("[{>])/u;
const PIPE_LABEL = /^\s*\|([^|]*)\|/;

interface NodeRecord {
  id: string;
  type: MermaidElement['type'];
  label: string;
  /** Whether a bracket ever named it — a bare mention keeps the id as its text, as Mermaid does. */
  shaped: boolean;
  group?: string;
}

interface SubgraphRecord {
  id: string;
  label: string;
  parent?: string;
}

/** Thrown mid-read when a list passes its cap; caught once, so the message is the whole answer. */
class Limit extends Error {}

class Unsupported {
  readonly items: string[] = [];
  add(item: string) {
    if (!this.items.includes(item)) this.items.push(item);
  }
}

/** The flowchart inside a Markdown document, when the text is one; else the text itself. */
export function unfence(text: string): string {
  const fenced = FENCE.exec(text);
  return fenced ? fenced[1]! : text;
}

/** Whether text reads as a Mermaid flowchart — cheap enough for every paste. */
export function looksLikeMermaid(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0 || text.length > MERMAID_LIMITS.textLength) return false;
  const body = stripFrontMatter(unfence(text));
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('%%')) continue;
    return HEADER.test(firstStatement(trimmed));
  }
  return false;
}

function stripFrontMatter(text: string): string {
  return text.replace(FRONT_MATTER, '');
}

function firstStatement(line: string): string {
  const semicolon = line.indexOf(';');
  return semicolon === -1 ? line : line.slice(0, semicolon);
}

/** Splits a line on `;` outside quotes and brackets — `graph LR; A-->B;` is three statements. */
function statementsOf(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '[' || ch === '(' || ch === '{')) depth += 1;
    else if (!quoted && (ch === ']' || ch === ')' || ch === '}')) depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && ch === ';') {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A `%%` comment is the rest of the line, unless the `%%` sits inside a quoted label. */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length - 1; i += 1) {
    const ch = line[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '%' && line[i + 1] === '%') return line.slice(0, i);
  }
  return line;
}

function decodeEntities(text: string): string {
  return text
    .replace(/#quot;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** Label text as the diagram shows it: quotes and backticks off, `<br>` a line break, other tags gone. */
function cleanLabel(raw: string, unsupported: Unsupported): string {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  if (/<[a-z][^>]*>/i.test(text)) {
    unsupported.add('HTML in labels (tags removed)');
    text = text.replace(/<\/?[a-z][^>]*>/gi, '');
  }
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

function fit(text: string, max: number, unsupported: Unsupported): string {
  if (text.length <= max) return text;
  unsupported.add(`labels longer than ${max} characters (shortened)`);
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Reads the text between a shape's brackets, honouring quotes so a `]` inside `"…"` does not end
 * the label. Returns the label and where the closer ends, or null when the closer never comes.
 */
function readBracketed(text: string, from: number, close: string): { raw: string; end: number } | null {
  let quoted = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && text.startsWith(close, i)) return { raw: text.slice(from, i), end: i + close.length };
  }
  return null;
}

interface NodeRef {
  id: string;
  type?: MermaidElement['type'];
  label?: string;
}

/** One node reference: an id, an optional shape with its label, an optional `:::class` or `@{…}`. */
function readNodeRef(text: string, unsupported: Unsupported): { ref: NodeRef; rest: string } | null {
  const trimmed = text.replace(/^\s+/, '');
  const id = ID.exec(trimmed)?.[0];
  if (!id) return null;
  let rest = trimmed.slice(id.length);
  const ref: NodeRef = { id };
  for (const shape of SHAPES) {
    if (!rest.startsWith(shape.open)) continue;
    const read = readBracketed(rest, shape.open.length, shape.close);
    if (!read) continue;
    ref.type = shape.type;
    ref.label = cleanLabel(read.raw, unsupported);
    rest = rest.slice(read.end);
    break;
  }
  const extended = /^@\{([^}]*)\}/.exec(rest);
  if (extended) {
    unsupported.add('@{ shape: … } node syntax (drawn as a plain shape)');
    const label = /label\s*:\s*("([^"]*)"|'([^']*)'|([^,}]+))/.exec(extended[1]!);
    if (label) ref.label = cleanLabel(label[2] ?? label[3] ?? label[4] ?? '', unsupported);
    ref.type ??= 'service';
    rest = rest.slice(extended[0].length);
  }
  const classed = /^:::[\p{L}\p{N}_-]+/u.exec(rest);
  if (classed) {
    unsupported.add(':::class on a shape');
    rest = rest.slice(classed[0].length);
  }
  return { ref, rest };
}

/** `A & B & C`: a group of nodes that all share the arrows around them. */
function readNodeGroup(text: string, unsupported: Unsupported): { refs: NodeRef[]; rest: string } | null {
  const refs: NodeRef[] = [];
  let rest = text;
  for (;;) {
    const read = readNodeRef(rest, unsupported);
    if (!read) return refs.length ? { refs, rest } : null;
    refs.push(read.ref);
    rest = read.rest;
    const amp = /^\s*&\s*/.exec(rest);
    if (!amp) return { refs, rest };
    rest = rest.slice(amp[0].length);
  }
}

interface Arrow {
  label?: string;
  dotted: boolean;
  headed: boolean;
  bidirectional: boolean;
  marker: boolean;
  invisible: boolean;
}

function readArrow(text: string, unsupported: Unsupported): { arrow: Arrow; rest: string } | null {
  let label: string | undefined;
  let rest = text;
  let match = TEXT_ARROW.exec(rest);
  let body: string;
  let head: string | undefined;
  let tail: string | undefined;
  if (match) {
    label = cleanLabel(match[4]!, unsupported);
    body = `${match[3]}${match[5]}`;
    tail = match[1] ?? match[2];
    head = match[6];
  } else {
    match = PLAIN_ARROW.exec(rest);
    if (!match) return null;
    body = match[3]!;
    tail = match[1] ?? match[2];
    head = match[4];
  }
  rest = rest.slice(match[0].length);
  const piped = PIPE_LABEL.exec(rest);
  if (piped) {
    label = cleanLabel(piped[1]!, unsupported);
    rest = rest.slice(piped[0].length);
  }
  const arrow: Arrow = {
    label: label || undefined,
    dotted: body.includes('.'),
    headed: head !== undefined,
    bidirectional: tail !== undefined && head !== undefined,
    marker: head === 'x' || head === 'o' || tail === 'x' || tail === 'o',
    invisible: body.startsWith('~'),
  };
  return { arrow, rest };
}

/** `subgraph id [title]`, `subgraph "title"`, `subgraph A title with spaces`. */
function readSubgraphHeader(statement: string, unsupported: Unsupported): { id: string; label: string } {
  const text = statement.slice('subgraph'.length).trim();
  const bracketed = /^([^\s[]+)\s*\[(.*)\]\s*$/.exec(text);
  if (bracketed) return { id: bracketed[1]!, label: cleanLabel(bracketed[2]!, unsupported) };
  const label = cleanLabel(text, unsupported);
  return { id: text, label };
}

/**
 * Reads a flowchart. Everything structural is kept; everything decorative is named in `unsupported`.
 * Refuses only what cannot be read at all: no `flowchart`/`graph` header, text past the limits.
 */
export function parseMermaidFlowchart(text: string): MermaidParse {
  if (typeof text !== 'string') return { ok: false, error: 'That is not text.' };
  if (text.length > MERMAID_LIMITS.textLength) {
    return { ok: false, error: `That text is ${(text.length / 1024).toFixed(0)} KB. Draft Canvas reads flowcharts up to ${MERMAID_LIMITS.textLength / 1024} KB.` };
  }
  const unsupported = new Unsupported();
  const unfenced = unfence(text);
  const front = FRONT_MATTER.exec(unfenced);
  let title: string | undefined;
  if (front) {
    const named = /^\s*title\s*:\s*(.+?)\s*$/m.exec(front[1]!);
    if (named) title = cleanLabel(named[1]!, unsupported);
  }
  const body = stripFrontMatter(unfenced);

  const statements: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const stripped = stripComment(line).trim();
    if (stripped === '') continue;
    statements.push(...statementsOf(stripped));
  }
  if (statements.length === 0) return { ok: false, error: 'There is no flowchart in that text.' };

  const header = HEADER.exec(statements[0]!);
  if (!header) {
    const word = statements[0]!.split(/\s+/)[0] ?? '';
    const kind = /^(sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|xychart|block|sankey|zenuml|packet|kanban|architecture)/i.exec(word);
    if (kind) return { ok: false, error: `Draft Canvas imports Mermaid flowcharts; that is a ${kind[1]}.` };
    return { ok: false, error: 'That text does not start with "flowchart" or "graph", so it is not a Mermaid flowchart.' };
  }
  const direction = DIRECTIONS[(header[1] ?? 'TD').toUpperCase()]!;
  if (direction.note) unsupported.add(direction.note);

  const nodes = new Map<string, NodeRecord>();
  const subgraphs = new Map<string, SubgraphRecord>();
  const relationships: { from: string; to: string; arrow: Arrow }[] = [];
  const stack: string[] = [];

  const declare = (ref: NodeRef): NodeRecord | null => {
    const group = stack.length ? stack[stack.length - 1] : undefined;
    let node = nodes.get(ref.id);
    if (!node) {
      if (subgraphs.has(ref.id)) return null;
      if (nodes.size >= MERMAID_LIMITS.nodes) throw new Limit(`This flowchart has more than ${MERMAID_LIMITS.nodes} shapes; Draft Canvas imports up to ${MERMAID_LIMITS.nodes} at a time.`);
      node = { id: ref.id, type: ref.type ?? 'service', label: ref.label ?? ref.id, shaped: ref.type !== undefined, group };
      nodes.set(ref.id, node);
      return node;
    }
    // A later declaration with a shape is what Mermaid shows; a bare mention changes nothing. A
    // node first seen outside any subgraph joins the first one that names it, as Mermaid draws it.
    if (ref.type !== undefined) {
      node.type = ref.type;
      node.label = ref.label ?? node.label;
      node.shaped = true;
    }
    if (!node.group && group) node.group = group;
    return node;
  };

  try {
    for (const statement of statements.slice(1)) {
      if (/^end$/i.test(statement)) {
        stack.pop();
        continue;
      }
      if (/^subgraph\b/i.test(statement)) {
        const { id, label } = readSubgraphHeader(statement, unsupported);
        if (!subgraphs.has(id)) {
          if (subgraphs.size >= MERMAID_LIMITS.groups) throw new Limit(`This flowchart has more than ${MERMAID_LIMITS.groups} subgraphs; Draft Canvas imports up to ${MERMAID_LIMITS.groups} at a time.`);
          subgraphs.set(id, { id, label: label || id, parent: stack.length ? stack[stack.length - 1] : undefined });
        }
        stack.push(id);
        continue;
      }
      const ignored = IGNORED.exec(statement);
      if (ignored) {
        unsupported.add(IGNORED_NAMES[ignored[1]!]!);
        continue;
      }
      const first = readNodeGroup(statement, unsupported);
      if (!first) {
        unsupported.add(`a line that could not be read: "${statement.slice(0, 40)}"`);
        continue;
      }
      let sources = first.refs.map(declare);
      let rest = first.rest;
      for (;;) {
        const arrow = readArrow(rest, unsupported);
        if (!arrow) break;
        const next = readNodeGroup(arrow.rest, unsupported);
        if (!next) {
          unsupported.add(`an arrow with nothing after it: "${statement.slice(0, 40)}"`);
          break;
        }
        const targets = next.refs.map(declare);
        for (const from of sources) {
          for (const to of targets) {
            if (!from || !to) {
              unsupported.add('arrows to or from a subgraph');
              continue;
            }
            if (arrow.arrow.invisible) {
              unsupported.add('invisible links (~~~)');
              continue;
            }
            if (relationships.length >= MERMAID_LIMITS.relationships) throw new Limit(`This flowchart has more than ${MERMAID_LIMITS.relationships} arrows; Draft Canvas imports up to ${MERMAID_LIMITS.relationships} at a time.`);
            relationships.push({ from: from.id, to: to.id, arrow: arrow.arrow });
          }
        }
        sources = targets;
        rest = next.rest;
      }
      if (rest.trim() !== '') unsupported.add(`text after a shape that could not be read: "${rest.trim().slice(0, 40)}"`);
    }
  } catch (error) {
    if (error instanceof Limit) return { ok: false, error: error.message };
    throw error;
  }

  if (nodes.size === 0) return { ok: false, error: 'That flowchart declares no shapes.' };

  // Mermaid ids are free text; the agent's are not. Every id is renumbered, in order of appearance,
  // and the labels carry the names.
  const nodeIds = new Map<string, string>();
  let n = 0;
  for (const id of nodes.keys()) nodeIds.set(id, `n${(n += 1)}`);
  const groupIds = new Map<string, string>();
  let g = 0;
  for (const id of subgraphs.keys()) groupIds.set(id, `g${(g += 1)}`);

  const groups: MermaidGroup[] = [];
  for (const sub of subgraphs.values()) {
    const group: MermaidGroup = { id: groupIds.get(sub.id)!, label: fit(sub.label, MERMAID_LIMITS.groupLabelLength, unsupported), kind: 'group' };
    if (sub.parent) group.parent = groupIds.get(sub.parent)!;
    groups.push(group);
  }

  const elements: MermaidElement[] = [];
  for (const node of nodes.values()) {
    const element: MermaidElement = { id: nodeIds.get(node.id)!, type: node.type, label: fit(node.label || node.id, MERMAID_LIMITS.labelLength, unsupported) };
    if (node.group) element.group = groupIds.get(node.group)!;
    elements.push(element);
  }

  let e = 0;
  const out: MermaidRelationship[] = relationships.map(({ from, to, arrow }) => {
    const relationship: MermaidRelationship = { id: `e${(e += 1)}`, from: nodeIds.get(from)!, to: nodeIds.get(to)! };
    if (arrow.label) relationship.label = fit(arrow.label, MERMAID_LIMITS.relationshipLabelLength, unsupported);
    if (arrow.dotted) relationship.async = true;
    if (!arrow.headed) relationship.directed = false;
    if (arrow.bidirectional) unsupported.add('two-headed arrows (drawn one way)');
    if (arrow.marker) unsupported.add('circle and cross arrowheads (drawn as plain arrows)');
    return relationship;
  });

  return {
    ok: true,
    create: {
      title: title || 'Imported flowchart',
      nodes: elements,
      relationships: out,
      groups,
      layout: { direction: direction.direction, allowDegraded: true },
    },
    unsupported: unsupported.items,
  };
}
