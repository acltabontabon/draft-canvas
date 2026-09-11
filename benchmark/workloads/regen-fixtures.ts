/**
 * Maintenance script — regenerates the checked-in `.draftcanvas` fixtures under
 * `benchmark/workloads/fixtures/`. Run manually via `npm run benchmark:regen-fixtures`
 * whenever `buildWorkloadDocument`, the starter catalog, or the capability matrix changes; never
 * run automatically as part of a benchmark run (fixtures are loaded as stable, pre-generated files
 * so "did the generator change" is never a confound between runs).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkloadDocument } from './generator';
import { WORKLOAD_SPECS } from './index';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function main(): void {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const spec of Object.values(WORKLOAD_SPECS)) {
    const document = buildWorkloadDocument(spec);
    const outPath = join(FIXTURES_DIR, `${spec.name}.draftcanvas.json`);
    writeFileSync(outPath, JSON.stringify(document, null, 2));
    console.log(
      `Wrote ${outPath} — ${document.nodes.length} nodes, ${document.edges.length} edges, ${document.flows.length} flows`,
    );
  }
}

main();
