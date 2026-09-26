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
    for (const name of ['get_capabilities', 'list_diagrams', 'read_diagram']) expect(by.get(name)?.annotations.readOnlyHint).toBe(true);
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
    expect(JSON.stringify(TOOLS).length).toBeLessThan(31_900);
  });
});
