/**
 * Writes the MCP tool definitions (`src/agent/schema.ts`) to `src-tauri/mcp/tools.json` and the
 * companion's own to `run-tools.json`, which the sidecar compiles in, and the relationship pairings the agent skill's checker reads
 * (`skills/draft-canvas/scripts/pairings.json`). `tests/agent/schema.test.ts` and
 * `tests/agent-skill.test.ts` fail when they drift; run this to bring them back in step:
 * `npm run agent:schemas`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUN_TOOLS, TOOLS } from '../src/agent/schema';
import { ELEMENT_TYPE_ALIASES, ELEMENT_TYPE_NAMES, resolveType } from '../src/agent/vocabulary';
import { capabilityFor, categoryOf, type NodeCategory } from '../src/document/connectorSemantics';

export function toolsJson(): string {
  return `${JSON.stringify(TOOLS, null, 2)}\n`;
}

/** The tools only a companion run is offered (`RUN_TOOLS`), compiled into the sidecar beside them. */
export function runToolsJson(): string {
  return `${JSON.stringify(RUN_TOOLS, null, 2)}\n`;
}

/**
 * Which relationship meanings Draft Canvas offers between two element types — the editor's own
 * capability matrix, flattened for a script that can't import it. A pairing with no entry has no
 * opinion: any meaning is kept. One the pairing doesn't offer is replaced on create, with an advisory.
 */
export function skillPairingsJson(): string {
  const categories: Record<string, NodeCategory> = {};
  // The words `resolveType` accepts (the enum's and its aliases), and which of them may hold an inside
  // view — the same rule `input.ts` applies, so the checker never refuses what the app accepts.
  const holdsInside: string[] = [];
  for (const word of [...ELEMENT_TYPE_NAMES, ...ELEMENT_TYPE_ALIASES]) {
    const shape = resolveType(word);
    if (!shape) continue;
    categories[word] = categoryOf(shape);
    if (shape.type === 'service' || (shape.type === 'component' && shape.componentKind !== 'port')) holdsInside.push(word);
  }
  const distinct = [...new Set(Object.values(categories))].sort();
  const offered: Record<string, string[]> = {};
  for (const source of distinct) {
    for (const target of distinct) {
      const relations = capabilityFor(source, target)?.relations;
      if (relations?.length) offered[`${source}>${target}`] = [...relations];
    }
  }
  return `${JSON.stringify({ generatedBy: 'npm run agent:schemas', categories, holdsInside, offered }, null, 1)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = fileURLToPath(new URL('../src-tauri/mcp/tools.json', import.meta.url));
  writeFileSync(target, toolsJson());
  console.log(`wrote ${target}`);
  const runTarget = fileURLToPath(new URL('../src-tauri/mcp/run-tools.json', import.meta.url));
  writeFileSync(runTarget, runToolsJson());
  console.log(`wrote ${runTarget}`);
  const pairings = fileURLToPath(new URL('../skills/draft-canvas/scripts/pairings.json', import.meta.url));
  writeFileSync(pairings, skillPairingsJson());
  console.log(`wrote ${pairings}`);
}
