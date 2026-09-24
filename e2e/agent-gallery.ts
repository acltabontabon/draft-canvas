/**
 * Renders the agent layout gallery (`tests/fixtures/agent/gallery.ts`) in the real editor, light and
 * dark, at two desktop sizes — for a person to look at, since geometry assertions can't say whether
 * a diagram reads well.
 *
 * Each case is composed *in the page*, with the editor's own canvas text measurement (not the static
 * approximation unit tests use), checked by the same quality gate, imported through the file picker,
 * fitted to the window and captured. Drill-down views (C4 containers/components) are captured too.
 *
 *   npx tsx e2e/agent-gallery.ts --base http://localhost:5184 --out <dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const BASE = flag('base') ?? 'http://localhost:5180';
const OUT = flag('out') ?? 'gallery-out';
const ONLY = flag('only');
/** 2 for a close look at captions and arrowheads; the gallery itself is captured at 1. */
const DPR = Number(flag('dpr') ?? 1);
const SIZES = flag('size') ? [{ width: Number(flag('size')), height: Math.round((Number(flag('size')) * 900) / 1440) }] : [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const SCHEMES = flag('scheme') ? [flag('scheme') as 'light' | 'dark'] : (['light', 'dark'] as const);

interface Rendered {
  id: string;
  views: { name: string; text: string }[];
  errors: string[];
  warnings: string[];
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const report: unknown[] = [];
  try {
    const setup = await browser.newPage();
    // tsx names the functions it compiles with a `__name` helper the page doesn't have.
    await setup.addInitScript('window.__name = (fn) => fn;');
    await setup.goto(BASE);
    const cases = await setup.evaluate(async (only) => {
      // Loaded by the dev server inside the page. Typed loosely here: the page's modules aren't this
      // script's, and `e2e/vite-modules.d.ts` describes only the few the other specs use.
      // oxlint-disable-next-line typescript/no-explicit-any
      const load = (path: string) => import(/* @vite-ignore */ path) as Promise<any>;
      const { GALLERY } = await load('/tests/fixtures/agent/gallery.ts');
      const { compose } = await load('/src/agent/compile.ts');
      const { applyUpdate } = await load('/src/agent/patch.ts');
      const { measureContext } = await load('/src/agent/place.ts');
      const { checkQuality } = await load('/src/agent/quality.ts');
      const { deserializeDocument, serializeDocument } = await load('/src/export/project.ts');
      const { viewOf, walkGraphs } = await load('/src/depth/tree.ts');
      const out: Rendered[] = [];
      for (const entry of GALLERY) {
        if (only && !entry.id.startsWith(only)) continue;
        const refusals: string[] = [];
        const make = (request: Record<string, unknown>) => {
          let text: string;
          try {
            text = compose({ requestId: 'g', ...request }, `d_${entry.id.slice(0, 2)}gallery0`).text;
          } catch (error) {
            // Refused as unreadable: recorded, then drawn anyway so the refusal can be looked at.
            const problems = (error as { details?: { problems?: string[] } }).details?.problems ?? [];
            refusals.push(`REFUSED: ${(error as { message?: string }).message ?? error} ${problems.join(' ')}`);
            const layout = { ...((request.layout as Record<string, unknown>) ?? {}), allowDegraded: true };
            text = compose({ requestId: 'g', ...request, layout }, `d_${entry.id.slice(0, 2)}gallery0`).text;
          }
          const parsed = deserializeDocument(text);
          if (!parsed.ok) throw new Error(parsed.error);
          return parsed.document;
        };
        let doc;
        let touched: Set<string> | undefined;
        try {
          if (entry.kind === 'create') doc = make(entry.request);
          else {
            let base = make(entry.base);
            if (entry.arrange) base = { ...base, nodes: base.nodes.map((n: { id: string }) => (entry.arrange?.[n.id] ? { ...n, ...entry.arrange[n.id] } : n)) };
            const result = applyUpdate(base, [], entry.update.ops, undefined);
            doc = result.file;
            touched = result.touched;
          }
        } catch (error) {
          out.push({ id: entry.id, views: [], errors: [String((error as { message?: string }).message ?? error)], warnings: [] });
          continue;
        }
        const errors: string[] = [...refusals];
        const warnings: string[] = [];
        const views: { name: string; text: string }[] = [];
        const ctx = measureContext();
        walkGraphs(doc, (_graph: unknown, path: string[]) => {
          const view = path.length ? viewOf(doc, path)! : doc;
          const q = checkQuality(view.nodes, view.edges, ctx, path.length === 0 ? touched : undefined);
          errors.push(...q.errors.map((e: { message: string }) => `${path.join('/') || 'top'}: ${e.message}`));
          warnings.push(...q.warnings.map((e: { message: string }) => `${path.join('/') || 'top'}: ${e.message}`));
          // A drill-down is captured on its own, as the person sees it after stepping inside.
          const standalone = path.length ? { ...view, metadata: { ...view.metadata, id: `${view.metadata.id}-${path.join('-')}`, title: `${view.metadata.title} ▸ ${path.join(' ▸ ')}` } } : view;
          views.push({ name: path.length ? `inside-${path.join('-')}` : 'top', text: serializeDocument(standalone) });
        });
        out.push({ id: entry.id, views, errors, warnings });
      }
      return out;
    }, ONLY ?? null);
    await setup.close();

    for (const scheme of SCHEMES) {
      for (const size of SIZES) {
        const context = await browser.newContext({ colorScheme: scheme, viewport: size, deviceScaleFactor: DPR });
        const page = await context.newPage();
        for (const entry of cases) {
          for (const view of entry.views) {
            await page.goto(BASE);
            await page.setInputFiles('input[type="file"]', { name: `${entry.id}.draftcanvas`, mimeType: 'application/json', buffer: Buffer.from(view.text) });
            await page.waitForSelector('.dc-editor');
            await page.waitForSelector('.dc-node');
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await page.keyboard.press('Shift+1');
            await page.waitForTimeout(600);
            await page.screenshot({ path: join(OUT, `${entry.id}-${view.name}-${scheme}-${size.width}.png`) });
          }
        }
        await context.close();
      }
    }
    for (const entry of cases) report.push({ id: entry.id, views: entry.views.map((v) => v.name), errors: entry.errors, warnings: entry.warnings });
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  } finally {
    await browser.close();
  }
}

void main();
