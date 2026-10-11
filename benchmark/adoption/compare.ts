/** Repeatable adoption gate. Libraries stay out of the editor until the gallery passes. */
import { writeFileSync, mkdirSync } from 'node:fs';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { GALLERY } from '../../tests/fixtures/agent/gallery';
import { TOOLS } from '../../src/agent/schema';
import { compose } from '../../src/agent/compile';
import { assignAnchors } from '../../src/layout/anchors';
import { renderDocumentSvg } from '../../src/render/svg/document';
import { anchorRectOf, captionSizer, measureContext } from '../../src/agent/place';
import { checkQuality } from '../../src/agent/quality';
import { deserializeDocument } from '../../src/export/project';
import { StaticTextMeasurer, setMeasurer } from '../../src/render/text/measure';

setMeasurer(new StaticTextMeasurer());
const elk = new ELK();
const ajv = new Ajv({ strict: false, allErrors: true, code: { source: true, esm: true } });
const tool = TOOLS.find((t) => t.name === 'create_diagram')!;
const validate = ajv.compile(tool.inputSchema);
mkdirSync('benchmark/results/adoption', { recursive: true });
writeFileSync('benchmark/results/adoption/validate-create.mjs', standaloneCode(ajv, validate));
const reports = [];
for (const fixture of GALLERY) {
  if (fixture.kind !== 'create') continue;
  const schemaValid = validate({ requestId: fixture.id, ...fixture.request });
  const schemaErrors = structuredClone(validate.errors);
  try {
    const parsed = deserializeDocument(compose({ ...fixture.request, layout: { ...(fixture.request.layout as object), allowDegraded: true } }, 'd_adoption').text);
    if (!parsed.ok) throw new Error(parsed.error);
    const doc = parsed.document;
    const direction = (fixture.request.layout as { direction?: string } | undefined)?.direction === 'down' ? 'down' : 'right';
    const caption = captionSizer(doc.nodes, measureContext());
    const nodes = new Map<string, ElkNode>(doc.nodes.map((n) => [n.id, { id: n.id, width: n.width, height: n.height, ...(n.type === 'group' ? { children: [], layoutOptions: { 'elk.padding': '[top=80,left=32,bottom=32,right=32]' } } : {}) }]));
    const root: ElkNode = { id: 'root', children: [], edges: doc.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target], labels: e.label ? [{ text: e.label, ...caption(e) }] : [] })), layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': direction === 'down' ? 'DOWN' : 'RIGHT', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.randomSeed': '1', 'elk.spacing.nodeNode': '64', 'elk.layered.spacing.nodeNodeBetweenLayers': '160' } };
    for (const n of doc.nodes) (n.parentId ? nodes.get(n.parentId)! : root).children!.push(nodes.get(n.id)!);
    const started = performance.now();
    const result = await elk.layout(root);
    const elapsedMs = performance.now() - started;
    const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
    function walk(node: ElkNode, x = 0, y = 0) {
      x += node.x ?? 0; y += node.y ?? 0;
      positions.set(node.id, { x, y, width: node.width ?? 0, height: node.height ?? 0 });
      node.children?.forEach((child) => walk(child, x, y));
    }
    walk(result);
    const placed = doc.nodes.map((n) => ({ ...n, ...positions.get(n.id)! }));
    const anchors = assignAnchors(doc.edges, new Map(placed.map((n) => [n.id, anchorRectOf(n)])), direction);
    const edges = doc.edges.map((e) => ({ ...e, ...anchors.get(e.id) }));
    for (const theme of ['light', 'dark'] as const) {
      writeFileSync(`benchmark/results/adoption/${fixture.id}-${theme}-baseline.svg`, renderDocumentSvg(doc, { theme }).svg);
      writeFileSync(`benchmark/results/adoption/${fixture.id}-${theme}-elk.svg`, renderDocumentSvg({ ...doc, nodes: placed, edges }, { theme }).svg);
    }
    reports.push({ id: fixture.id, schemaValid, schemaErrors, elapsedMs, baseline: checkQuality(doc.nodes, doc.edges, measureContext()), elk: checkQuality(placed, edges, measureContext()), deterministic: JSON.stringify(await elk.layout(root)) === JSON.stringify(result) });
  } catch (error) {
    reports.push({ id: fixture.id, schemaValid, schemaErrors, error: String(error) });
  }
}
writeFileSync('benchmark/results/adoption/comparison.json', JSON.stringify(reports, null, 2) + '\n');
console.log(`Compared ${reports.length} gallery cases; see benchmark/results/adoption/comparison.json`);
