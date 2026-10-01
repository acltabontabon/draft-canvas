/**
 * The sidecar compiles `src-tauri/mcp/tools.json` in; `src/agent/schema.ts` is where the tools are
 * defined. A schema change that isn't regenerated would ship an agent a contract the app no longer
 * honours — so the two must match byte for byte (`npm run agent:schemas` rewrites the file).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/agent/schema';

const toolsJson = () => readFileSync(join(process.cwd(), 'src-tauri/mcp/tools.json'), 'utf8');

// oxlint-disable-next-line typescript/no-explicit-any -- a JSON Schema node, walked by key below
type Loose = Record<string, any>;
const tool = (name: string): Loose => TOOLS.find((t) => t.name === name) as unknown as Loose;

/**
 * Just enough JSON Schema to hold a request against the published shape — the keywords these schemas
 * use (type, properties, required, additionalProperties, enum, oneOf, items, local $ref) and nothing
 * else. The app validates with `input.ts`, not a schema; this checks that the schema a client sees
 * refuses what the app refuses, which is the only reason to type it tightly.
 */
function conforms(schema: Loose, value: unknown, root: Loose): boolean {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/$defs/', '');
    const target = root.$defs?.[name];
    if (!target) throw new Error(`dangling ${schema.$ref}`);
    return conforms(target, value, root);
  }
  if (Array.isArray(schema.oneOf)) return schema.oneOf.filter((s: Loose) => conforms(s, value, root)).length === 1;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((s: Loose) => conforms(s, value, root));
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) return false;
    for (const [key, item] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (!property) {
        if (schema.additionalProperties === false) return false;
        if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !conforms(schema.additionalProperties, item, root)) return false;
        continue;
      }
      if (!conforms(property, item, root)) return false;
    }
    return true;
  }
  if (schema.type === 'array') return Array.isArray(value) && (!schema.items || value.every((item) => conforms(schema.items, item, root)));
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number';
  return true;
}

/** Every `$ref` string under `schema`. */
function refsIn(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((s) => refsIn(s, out));
  else if (schema && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else refsIn(value, out);
    }
  }
  return out;
}

describe('MCP tool definitions', () => {
  it('are the ones the sidecar compiles in', () => {
    expect(toolsJson()).toBe(`${JSON.stringify(TOOLS, null, 2)}\n`);
  });

  it('name the documented tools, each with an object input schema and annotations', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'get_capabilities',
      'list_diagrams',
      'read_diagram',
      'read_selection',
      'get_implementation_context',
      'render_diagram',
      'create_diagram',
      'update_diagram',
      'submit_proposal',
      'get_proposal',
      'list_proposals',
    ]);
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('mark the reads read-only and the edits idempotent by request id', () => {
    type Loose = { annotations: Record<string, unknown>; inputSchema: { required?: readonly string[] } };
    const by = new Map<string, Loose>(TOOLS.map((t) => [t.name, t as unknown as Loose]));
    for (const name of ['get_capabilities', 'list_diagrams', 'read_diagram', 'render_diagram']) expect(by.get(name)?.annotations.readOnlyHint).toBe(true);
    for (const name of ['create_diagram', 'update_diagram']) {
      expect(by.get(name)?.annotations.readOnlyHint).toBe(false);
      expect(by.get(name)?.annotations.idempotentHint).toBe(true);
      expect(by.get(name)?.inputSchema.required ?? []).toContain('requestId');
    }
    expect(by.get('update_diagram')?.annotations.destructiveHint).toBe(true);
  });

  it('gives submit_proposal the exact same layout schema as update_diagram, never a hand-copy', () => {
    // `submit_proposal.layout` once hand-duplicated `update_diagram.layout`'s shape and silently
    // fell behind it when `viewport`/`normalizePeerSizes` were added there — this pins them to the
    // same object so that class of drift can't recur.
    type Loose = { inputSchema: { properties: Record<string, unknown> } };
    const by = new Map<string, Loose>(TOOLS.map((t) => [t.name, t as unknown as Loose]));
    expect(by.get('submit_proposal')?.inputSchema.properties.layout).toBe(by.get('update_diagram')?.inputSchema.properties.layout);
  });

  it('describe update_diagram ops as one closed schema per op, shared with submit_proposal', () => {
    const update = tool('update_diagram').inputSchema;
    const variants: Loose[] = update.properties.ops.items.oneOf;
    expect(variants.map((v) => v.properties.op.enum)).toEqual([['add'], ['update'], ['remove'], ['setLevel'], ['arrange']]);
    for (const variant of variants) {
      expect(variant.additionalProperties).toBe(false);
      expect(variant.required).toContain('op');
    }
    // One object, so a field added to an op for update_diagram can never be missing from a proposal.
    expect(tool('submit_proposal').inputSchema.properties.ops.items).toBe(update.properties.ops.items);
    expect(tool('submit_proposal').inputSchema.properties.ops.minItems).toBeUndefined();
    expect(update.properties.ops.minItems).toBe(1);
  });

  it('refuses, in every op, a field that belongs to another op or to no op', () => {
    const root = tool('update_diagram').inputSchema;
    const op = root.properties.ops.items;
    const accepted = [
      { op: 'add', nodes: [{ id: 'a', type: 'service', label: 'A' }], relationships: [{ id: 'r', from: 'a', to: 'a', kind: 'async' }], openPoints: [{ kind: 'awaiting', about: ['a'] }] },
      { op: 'update', id: 'a', set: { label: 'B', group: null } },
      { op: 'remove', ids: ['a', 'r'], cascade: true },
      { op: 'setLevel', level: null },
      { op: 'setLevel', level: 'container' },
      { op: 'arrange' },
      { op: 'arrange', scope: { group: 'g' }, connectors: 'keep', move: false, direction: 'down', spacing: 'compact', primaryFlow: 'f' },
    ];
    for (const sample of accepted) expect(conforms(op, sample, root), JSON.stringify(sample)).toBe(true);
    const refused = [
      { op: 'add', ids: ['a'] },
      { op: 'add', id: 'a', set: {} },
      { op: 'add', nodes: [{ id: 'a', type: 'service', label: 'A', lable: 'typo' }] },
      { op: 'update', id: 'a', set: {}, cascade: true },
      { op: 'update', id: 'a' },
      { op: 'remove', ids: ['a'], set: {} },
      { op: 'remove', ids: ['a'], scope: { group: 'g' } },
      { op: 'setLevel' },
      { op: 'setLevel', level: 'context', nodes: [] },
      { op: 'arrange', nodes: [] },
      { op: 'arrange', level: 'context' },
      { op: 'explode' },
      { nodes: [] },
    ];
    for (const sample of refused) expect(conforms(op, sample, root), JSON.stringify(sample)).toBe(false);
  });

  it('type an element\'s inside view to the depth limit, through local $defs that all resolve', () => {
    for (const name of ['create_diagram', 'update_diagram', 'submit_proposal']) {
      const root = tool(name).inputSchema;
      const defs = root.$defs as Record<string, Loose>;
      const element = (depth: number): Loose => defs[`element${depth}`] ?? expect.fail(`no element${depth} in ${name}'s $defs`);
      expect(element(0).properties.inside.properties.nodes.items).toEqual({ $ref: '#/$defs/element1' });
      expect(element(1).properties.inside.properties.nodes.items).toEqual({ $ref: '#/$defs/element2' });
      expect(element(2).properties.inside.properties.nodes.items).toEqual({ $ref: '#/$defs/element3' });
      expect(element(3).properties.inside).toBeUndefined();
      // Every reference is local and resolves in this very tool: a client resolves nothing elsewhere.
      const refs = refsIn(root);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(ref.startsWith('#/$defs/') && ref.replace('#/$defs/', '') in defs, ref).toBe(true);
    }
    // No tool references what it doesn't define.
    for (const t of TOOLS) if (!(t.inputSchema as Loose).$defs) expect(refsIn(t.inputSchema)).toEqual([]);

    // A misspelt field three rooms down is caught like one at the top; a fourth room is not a room.
    const root = tool('create_diagram').inputSchema;
    const nested = (leaf: Loose) => ({
      requestId: 'r',
      title: 'T',
      nodes: [{ id: 'a', type: 'service', label: 'A', inside: { nodes: [{ id: 'b', type: 'service', label: 'B', inside: { nodes: [{ id: 'c', type: 'service', label: 'C', inside: { nodes: [leaf] } }] } }] } }],
    });
    expect(conforms(root, nested({ id: 'd', type: 'service', label: 'D' }), root)).toBe(true);
    expect(conforms(root, nested({ id: 'd', type: 'service', label: 'D', lable: 'typo' }), root)).toBe(false);
    expect(conforms(root, nested({ id: 'd', type: 'service', label: 'D', inside: { nodes: [] } }), root)).toBe(false);
  });

  it('offer read_diagram as source text, and render_diagram as a picture, with the formats the app has', () => {
    expect(tool('read_diagram').inputSchema.properties.format.enum).toEqual(['draft', 'mermaid', 'plantuml', 'c4']);
    const render = tool('render_diagram').inputSchema;
    expect(render.properties.format.enum).toEqual(['png', 'svg']);
    expect(render.properties.scale.enum).toEqual([1, 2, 3]);
    expect(render.properties.theme.enum).toEqual(['light', 'dark']);
    expect(render.required).toEqual(['diagramId']);
    expect(tool('render_diagram').annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it('stay compact enough to sit in an agent\'s context', () => {
    // The tool list goes to the model on every turn, as compact JSON: keep it under ~7.7k tokens
    // (estimated as characters / 4). Raised from 24k when submit_proposal/get_proposal/list_proposals
    // were added — a deliberate capability expansion, not drift — with submit_proposal's own `ops`
    // kept intentionally loose (input.ts validates regardless) rather than repeating update_diagram's
    // full room schema a second time. Raised again, slightly, when `submit_proposal.layout` was fixed
    // to reuse the shared `layoutBrief` (it had drifted into a hand-duplicated, narrower copy that
    // silently dropped `viewport`/`normalizePeerSizes` from a later `update_diagram` addition) —
    // sharing the object closes that drift permanently, at the cost of its description text appearing
    // twice in the compiled JSON. Raised a third time for the readability guidance in create_diagram,
    // group.kind and note.about — the sentences that stop an agent sending a request the layout can
    // only draw badly (externals grouped for tidiness, notes with no subject, no main path); the full
    // checklist is behind get_capabilities' `readability` topic rather than here. Raised a fourth
    // time, by a few hundred characters, for open points — the one new kind of thing an agent can
    // read and raise (`openPoint` in the add op, and its fields in `set`).
    // And once more, by a word, for the `implements` relationship — the mirror of `implementedBy`,
    // so a Hexagonal adapter's dependency on its port can be drawn the way it points.
    //
    // Raised from 31.9k to 57k when the ops became one closed schema per op, `submit_proposal.ops`
    // stopped being loose, and an element's `inside` was typed to the depth limit — three rooms
    // deep, in each of the three tools that take a room. Written out inline that came to 104k (the
    // nested rooms are a triangle); defined once per tool under `$defs` and referenced, it is this.
    // Every byte here is schema a client can validate against, not prose: the descriptions appear
    // once, on the top-level definitions, and the nested element definitions carry none.
    expect(JSON.stringify(TOOLS).length).toBeLessThan(57_000);
  });
});
