import { expect, test, type Page } from '@playwright/test';
import { installMockShell } from './mockShell';

/**
 * What the person sees while an AI agent works, in the real page with the shell faked: the status
 * line, the generation view for a new diagram, the provisional layer over the open one, and Cancel —
 * with each request held at its commit gate so the test can look at it mid-way.
 */

test.beforeEach(async ({ page }) => {
  await installMockShell(page);
});

const PLATFORM = {
  requestId: 'watch-1',
  title: 'Checkout platform',
  groups: [{ id: 'core', label: 'Checkout team', kind: 'boundary' }],
  nodes: [
    { id: 'edge', type: 'gateway', label: 'Edge Gateway' },
    { id: 'api', type: 'api', label: 'Checkout API', group: 'core' },
    { id: 'db', type: 'sql-database', label: 'Orders DB', group: 'core' },
    { id: 'q', type: 'queue', label: 'payments', group: 'core' },
    { id: 'w', type: 'worker', label: 'Payment Worker', group: 'core' },
  ],
  relationships: [
    { id: 'r1', from: 'edge', to: 'api', label: 'Routes /checkout' },
    { id: 'r2', from: 'api', to: 'db', label: 'Writes order' },
    { id: 'r3', from: 'api', to: 'q' },
    { id: 'r4', from: 'q', to: 'w' },
  ],
};

async function agentRequest(page: Page, id: number, tool: string, args: unknown, context: unknown = {}) {
  await page.evaluate(({ id, tool, args, context }) => window.__shell.emit({ type: 'agent-request', id, tool, args, context }), { id, tool, args, context });
}

const answer = (page: Page, id: number) => page.evaluate((id) => window.__shell.agentResponse(id), id) as Promise<{ ok: boolean; value?: Record<string, unknown>; error?: { code: string } } | undefined>;

test('an agent’s layout runs on its worker, not on the page it would freeze', async ({ page }) => {
  // The worker once threw as it loaded (a DOM-only dependency in its bundle), and every request
  // quietly ran on the main thread instead.
  await page.goto('/');
  const usable = await page.evaluate(async (platform) => {
    // Loaded by the dev server inside the page; `e2e/vite-modules.d.ts` types only the few other specs use.
    // oxlint-disable-next-line typescript/no-explicit-any
    const load = (path: string) => import(/* @vite-ignore */ path) as Promise<any>;
    const { runOffThread, __workerUsable } = await load('/src/agent/offThread.ts');
    await runOffThread({ kind: 'compose', raw: platform, diagramId: 'd_worker000001' });
    return __workerUsable();
  }, PLATFORM);
  expect(usable).toBe(true);
});

test('a new diagram being drawn from Home shows its stage and the diagram taking shape, then goes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  await page.evaluate(() => window.__shell.holdGate(true));

  await agentRequest(page, 1, 'create_diagram', PLATFORM, { diagramId: 'd_watch0000001' });

  const line = page.locator('.dc-agent-activity-line');
  await expect(line).toContainText('Drawing “Checkout platform”');
  const view = page.getByRole('region', { name: 'AI agent drawing Checkout platform' });
  await expect(view).toBeVisible();
  await expect(view.getByText('Not saved yet')).toBeVisible();
  await expect(view.locator('img.dc-agent-generation-image')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('generation-view.png') });

  await page.evaluate(() => window.__shell.holdGate(false));
  await expect.poll(async () => (await answer(page, 1))?.ok).toBe(true);
  expect((await answer(page, 1))?.value?.openAfter).toBe(true);
  // Answered: nothing of it is left on screen.
  await expect(line).toHaveCount(0);
  await expect(view).toHaveCount(0);
  const progress = await page.evaluate(() => window.__shell.agentProgress().map((p) => p.message));
  expect(progress[0]).toBe('Preparing diagram');
});

test('Cancel before the gate changes nothing; a change to the open diagram previews on top of it until then', async ({ page }) => {
  await page.goto('/');
  // The open diagram: made by the page's own composer, opened like any file.
  const text = await page.evaluate(async (platform) => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const load = (path: string) => import(/* @vite-ignore */ path) as Promise<any>;
    const { compose } = await load('/src/agent/compile.ts');
    return compose(platform, 'd_open00000001').text;
  }, PLATFORM);
  const handle = await page.evaluate((text) => {
    const added = window.__shell.addFile('Checkout platform', text);
    window.__shell.nextOpen(added);
    return added;
  }, text);
  await page.getByRole('button', { name: 'Open file…' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.evaluate(() => window.__shell.holdGate(true));

  const revision = await page.evaluate(async () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const load = (path: string) => import(/* @vite-ignore */ path) as Promise<any>;
    const { currentRevision } = await load('/src/host/agentBridge.ts');
    return currentRevision();
  });
  await agentRequest(
    page,
    2,
    'update_diagram',
    {
      requestId: 'watch-2',
      diagramId: 'd_open00000001',
      expectedRevision: revision,
      ops: [{ op: 'add', nodes: [{ id: 'dlq', type: 'dead-letter-queue', label: 'payments-dlq', group: 'core' }], relationships: [{ id: 'r5', from: 'q', to: 'dlq', label: 'After 5 attempts' }] }],
    },
    { handle, open: true, diagramId: 'd_open00000001' },
  );

  // (The layer itself is a zero-size positioning box; what it draws is what shows.)
  const preview = page.locator('.dc-agent-preview');
  await expect(preview.getByText('Agent’s proposed change')).toBeVisible();
  await expect(preview.locator('.dc-ghost-node')).not.toHaveCount(0);
  await expect(page.locator('.dc-agent-activity-line')).toContainText('Updating “Checkout platform”');
  await page.screenshot({ path: test.info().outputPath('update-preview.png') });

  await page.locator('.dc-agent-activity-line').getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await answer(page, 2))?.error?.code).toBe('CANCELLED');
  await expect(preview).toHaveCount(0);
  await expect(page.locator('.dc-agent-activity-line')).toHaveCount(0);
  // The document never had the change.
  await expect(page.locator('.react-flow__node').filter({ hasText: 'payments-dlq' })).toHaveCount(0);
  await page.evaluate(() => window.__shell.holdGate(false));
});
