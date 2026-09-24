/**
 * Writes the MCP tool definitions (`src/agent/schema.ts`) to `src-tauri/mcp/tools.json`, which the
 * sidecar compiles in. `tests/agent/schema.test.ts` fails when the two drift; run this to bring them
 * back in step: `npm run agent:schemas`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/agent/schema';

export function toolsJson(): string {
  return `${JSON.stringify(TOOLS, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = fileURLToPath(new URL('../src-tauri/mcp/tools.json', import.meta.url));
  writeFileSync(target, toolsJson());
  console.log(`wrote ${target}`);
}
