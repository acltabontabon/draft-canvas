/**
 * Refreshes Nodi's guide images through the real desktop UI with a deterministic fake shell and
 * agent stream. Run manually: npx tsx e2e/desktop/docs-screenshots.ts --release 1.16.0
 * No provider is contacted. Diagram files and proposals enter through the mock shell, as in e2e.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { NAME_SHIM } from '../../demo/overlay';
import type { RunEvent } from '../../src/desktop/api';
import { chooseWorkFile } from './explorer';
import { installMockShell } from './mockShell';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'docs/media/guides');
const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;
const DIAGRAM = 'd_open00000001';
const releaseAt = process.argv.indexOf('--release');
const RELEASE = releaseAt < 0 ? null : process.argv[releaseAt + 1];

const ORDERS = {
  requestId: 'nodi-guide',
  title: 'Order processing',
  nodes: [
    { id: 'api', type: 'api', label: 'Orders API' },
    { id: 'q', type: 'queue', label: 'orders' },
    { id: 'w', type: 'worker', label: 'Fulfilment worker' },
    { id: 'db', type: 'sql-database', label: 'Orders database' },
  ],
  relationships: [
    { id: 'r1', from: 'api', to: 'q', label: 'sends' },
    { id: 'r2', from: 'q', to: 'w', label: 'consumed by' },
    { id: 'r3', from: 'w', to: 'db', label: 'reads / writes' },
  ],
};

async function startServer(): Promise<() => Promise<void>> {
  const child = spawn('npm', ['run', 'dev', '--', '--mode', 'desktop', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'pipe',
    detached: true,
  });
  let exited = false;
  child.once('exit', () => { exited = true; });
  const stop = async () => {
    if (child.pid === undefined || exited) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Desktop dev server exited; check port ${PORT}.`);
    try {
      if ((await fetch(BASE_URL)).ok) return stop;
    } catch { /* Wait for Vite to listen. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await stop();
  throw new Error('Desktop dev server did not become ready.');
}

async function openOrders(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => process.stderr.write(`${error.stack ?? error.message}\n`));
  await page.clock.setFixedTime(new Date('2026-10-24T06:00:00Z'));
  await page.addInitScript({ content: NAME_SHIM });
  await installMockShell(page);
  await page.goto(BASE_URL);
  const text = await page.evaluate(async (orders) => {
    const modulePath = '/src/agent/compile.ts';
    const { compose } = await import(/* @vite-ignore */ modulePath);
    return compose(orders, 'd_open00000001').text as string;
  }, ORDERS);
  await page.evaluate((text) => {
    window.__shell.addFile('Order processing', text);
    window.__shell.setAgent({ enabled: true, listening: true });
  }, text);
  await page.getByRole('button', { name: 'Open file…' }).click();
  await chooseWorkFile(page, 'Order processing');
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  // Leave room for the conversation beside the drawing, using the same camera controls as a person.
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.waitForTimeout(250);
  await page.mouse.move(500, 180);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(370, 180, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(8, 72);
  // Camera reveals and type-in text must settle before the screenshot.
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
  process.stdout.write(`Captured ${name}.png\n`);
}

async function ask(page: Page, prompt: string): Promise<string> {
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  const input = page.getByLabel('Message Claude Code');
  await input.fill(prompt);
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(1);
  return page.evaluate(() => window.__shell.companionSent()[0]!.runId);
}

async function emit(page: Page, run: string, event: RunEvent): Promise<void> {
  await page.evaluate(({ run, event }) => window.__shell.emit({ type: 'companion', run, event }), { run, event });
}

async function stop(page: Page, run: string): Promise<void> {
  await emit(page, run, { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: { input: 48_169, cached: 30_000, output: 400 } });
}

async function proposal(page: Page, run: string, id: string, ops: unknown[], summary: string, counts: { added: number; updated: number; removed: number }): Promise<void> {
  await page.evaluate(({ run, id, ops, summary, counts, diagramId }) => window.__shell.addProposal({
    proposalId: id, version: 1, diagramId, path: [], status: 'pending', baseRevision: 'o:seed.0',
    ops, layout: null, preconditions: { nodes: {}, edges: {} }, counts, summary, rationale: '',
    assumptions: [], openQuestions: [], sourceRef: null, createdAt: Date.now(), updatedAt: Date.now(),
    resolvedAt: null, stale: false, run,
  }), { run, id, ops, summary, counts, diagramId: DIAGRAM });
  await page.evaluate(() => window.__shell.emit({ type: 'agent-changed' }));
  await stop(page, run);
  await expect(page.getByRole('region', { name: 'Proposed change' }).getByRole('button', { name: 'Accept' })).toBeEnabled();
}

async function capture(browser: Browser): Promise<void> {
  const welcome = await openOrders(browser);
  await expect(welcome.getByRole('button', { name: 'Open Nodi' })).toBeVisible();
  await shot(welcome, 'nodi-rest');
  await welcome.getByRole('button', { name: 'Open Nodi' }).click();
  await expect(welcome.getByRole('list', { name: 'Ask Nodi' })).toBeVisible();
  await shot(welcome, 'nodi-open');
  await welcome.getByLabel('Message Claude Code').fill('What can you do?');
  await welcome.getByLabel('Message Claude Code').press('Enter');
  await expect(welcome.locator('.dc-companion-speech')).toContainText('Three kinds of things');
  await shot(welcome, 'nodi-help');
  await welcome.context().close();

  const risks = await openOrders(browser);
  const riskRun = await ask(risks, 'What are the risks here?');
  await emit(risks, riskRun, { type: 'started', session: 'guide-risks' });
  await emit(risks, riskRun, { type: 'tool-call', id: 'read', tool: 'read_diagram', status: 'in-progress' });
  await expect(risks.getByRole('button', { name: 'Stop' })).toBeVisible();
  await shot(risks, 'nodi-thinking');
  await emit(risks, riskRun, { type: 'tool-call-update', id: 'read', status: 'completed', error: null });
  await emit(risks, riskRun, { type: 'message-chunk', text: [
    'The main risks, in order of how much they matter:',
    '',
    '- **Hot reads on one database.** Every order read goes from [[w]] to [[db]] over [[r3]]: it takes the whole read load.',
    '- **No dead-letter path.** A message [[w]] can never process is retried forever from [[q]].',
    '- **Publish after responding.** If [[api]] answers before publishing, a failed publish can lose the order.',
  ].join('\n') });
  await stop(risks, riskRun);
  await expect(risks.locator('.dc-companion-pin')).toHaveCount(3);
  await shot(risks, 'nodi-points');
  await risks.context().close();

  const changes = await openOrders(browser);
  const changeRun = await ask(changes, 'Put a cache in front of the database');
  await emit(changes, changeRun, { type: 'started', session: 'guide-cache' });
  await emit(changes, changeRun, { type: 'message-chunk', text: 'I proposed a cache-aside Orders cache: the worker reads it first and fills it on a miss; writes evict the entry.' });
  await proposal(changes, changeRun, 'p-cache', [
    {
      op: 'add',
      nodes: [{ id: 'cache', type: 'cache', label: 'Orders cache' }],
      relationships: [{ id: 'r4', from: 'w', to: 'cache', label: '1. Read first, 3. fill' }],
      notes: [{ id: 'policy', about: 'cache', kind: 'decision', text: 'Cache-aside. Entries live 5 minutes; a write updates the database, then evicts that order’s entry.' }],
      flows: [{ id: 'read-order', title: 'Read an order (cache-aside)', steps: [
        { relationship: 'r4', caption: 'Look in the cache first' },
        { relationship: 'r3', caption: 'On a miss, read the database' },
        { spotlight: ['cache', 'r4'], caption: 'Fill the cache for next time' },
      ] }],
    },
    { op: 'update', id: 'r3', set: { label: '2. Miss · writes' } },
  ], 'Cache-aside Orders cache: read first, fill on a miss, evict on write', { added: 3, updated: 1, removed: 0 });
  await shot(changes, 'nodi-proposal');
  if (RELEASE) {
    if (!/^\d+\.\d+\.\d+$/.test(RELEASE)) throw new Error('Use --release X.Y.Z.');
    const releaseDir = join(ROOT, 'docs/media/releases', `v${RELEASE}`);
    mkdirSync(releaseDir, { recursive: true });
    copyFileSync(join(OUT, 'nodi-proposal.png'), join(releaseDir, 'nodi.png'));
  }
  await changes.context().close();

  const tidy = await openOrders(browser);
  const tidyRun = await ask(tidy, 'Move the database under the API so the worker’s connector is short');
  await emit(tidy, tidyRun, { type: 'started', session: 'guide-tidy' });
  await emit(tidy, tidyRun, { type: 'message-chunk', text: 'I proposed a tidier layout: the database sits under the API, so the worker’s connector no longer runs the length of the diagram.' });
  await proposal(tidy, tidyRun, 'p-tidy', [{ op: 'update', id: 'db', set: { place: { below: 'api', gap: 96 } } }], 'Move the database under the API', { added: 0, updated: 1, removed: 0 });
  await expect(tidy.locator('.dc-agent-preview[data-mode="sheet"] .dc-preview-sheet')).toBeVisible();
  await shot(tidy, 'nodi-tracing');
  await tidy.context().close();
}

mkdirSync(OUT, { recursive: true });
const stopServer = await startServer();
let browser: Browser | undefined;
try {
  browser = await chromium.launch();
  await capture(browser);
} finally {
  await browser?.close();
  await stopServer();
}
