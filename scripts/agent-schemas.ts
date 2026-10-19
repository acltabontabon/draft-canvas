/**
 * Writes the MCP tool definitions (`src/agent/schema.ts`) to `src-tauri/mcp/tools.json`, which the
 * sidecar compiles in, and the relationship pairings the agent skill's checker reads
 * (`skills/draft-canvas/scripts/pairings.json`). `tests/agent/schema.test.ts` and
 * `tests/agent-skill.test.ts` fail when they drift; run this to bring them back in step:
 * `npm run agent:schemas`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/agent/schema';
import { ELEMENT_TYPE_NAMES, resolveType } from '../src/agent/vocabulary';
import { capabilityFor, categoryOf, type NodeCategory } from '../src/document/connectorSemantics';

export function toolsJson(): string {
  return `${JSON.stringify(TOOLS, null, 2)}\n`;
}

/**
 * Which relationship meanings Draft Canvas offers between two element types — the editor's own
 * capability matrix, flattened for a script that can't import it. A pairing with no entry has no
 * opinion: any meaning is kept. One the pairing doesn't offer is replaced on create, with an advisory.
 */
export function skillPairingsJson(): string {
  const categories: Record<string, NodeCategory> = {};
  for (const word of ELEMENT_TYPE_NAMES) {
    const shape = resolveType(word);
    if (shape) categories[word] = categoryOf(shape);
  }
  const distinct = [...new Set(Object.values(categories))].sort();
  const offered: Record<string, string[]> = {};
  for (const source of distinct) {
    for (const target of distinct) {
      const relations = capabilityFor(source, target)?.relations;
      if (relations?.length) offered[`${source}>${target}`] = [...relations];
    }
  }
  return `${JSON.stringify({ generatedBy: 'npm run agent:schemas', categories, offered }, null, 1)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = fileURLToPath(new URL('../src-tauri/mcp/tools.json', import.meta.url));
  writeFileSync(target, toolsJson());
  console.log(`wrote ${target}`);
  const pairings = fileURLToPath(new URL('../skills/draft-canvas/scripts/pairings.json', import.meta.url));
  writeFileSync(pairings, skillPairingsJson());
  console.log(`wrote ${pairings}`);
}
