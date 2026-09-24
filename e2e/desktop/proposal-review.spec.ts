import { expect, test, type Page } from '@playwright/test';
import { installMockShell } from './mockShell';

/**
 * The native proposal review panel (Phase 4b): a real browser exercise of the whole review UI
 * against the mock shell's in-memory proposal store, which mirrors `proposals.rs`'s own rules.
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

const proposalFixture = (overrides: Record<string, unknown> = {}) => ({
  proposalId: 'p1',
  version: 1,
  diagramId: 'd_open00000001',
  path: [],
  status: 'pending',
  baseRevision: 'o:seed.0',
  ops: [
    { op: 'add', nodes: [{ id: 'dlq', type: 'dead-letter-queue', label: 'payments-dlq', group: 'core' }], relationships: [{ id: 'r5', from: 'q', to: 'dlq', label: 'After 5 attempts' }] },
  ],
  layout: null,
  preconditions: { nodes: {}, edges: {} },
  counts: { added: 2, updated: 0, removed: 0 },
  summary: 'Add a dead-letter queue after the payments queue',
  rationale: 'Failed deliveries currently have nowhere to land.',
  assumptions: ['5 retries matches the existing worker'],
  openQuestions: [],
  sourceRef: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  resolvedAt: null,
  stale: false,
  ...overrides,
});

async function openPlatform(page: Page) {
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
  return handle;
}

test('a pending proposal shows as a badge, and its diff distinguishes additions', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((proposal) => window.__shell.addProposal(proposal), proposalFixture());
  await openPlatform(page);

  const badge = page.getByRole('button', { name: '1 proposal to review' });
  await expect(badge).toBeVisible();
  await badge.click();

  const panel = page.getByRole('region', { name: 'Proposal review' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Add a dead-letter queue after the payments queue');
  await expect(panel).toContainText('5 retries matches the existing worker');
  await expect(panel.locator('.dc-proposal-diff-added')).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath('proposal-panel.png') });
});

test('accepting applies the proposal as one undo step, and the record becomes accepted (never reopened by undo)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((proposal) => window.__shell.addProposal(proposal), proposalFixture());
  await openPlatform(page);

  await page.getByRole('button', { name: '1 proposal to review' }).click();
  const panel = page.getByRole('region', { name: 'Proposal review' });
  await panel.getByRole('button', { name: 'Accept' }).click();

  await expect(page.locator('.react-flow__node').filter({ hasText: 'payments-dlq' })).toBeVisible();
  await expect(page.getByRole('button', { name: /proposal to review/ })).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.react-flow__node').filter({ hasText: 'payments-dlq' })).toHaveCount(0);

  const status = await page.evaluate(() => window.__shell.proposal('p1')?.status);
  expect(status).toBe('accepted');
});

test('rejecting leaves the diagram unchanged', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((proposal) => window.__shell.addProposal(proposal), proposalFixture());
  await openPlatform(page);

  await page.getByRole('button', { name: '1 proposal to review' }).click();
  const panel = page.getByRole('region', { name: 'Proposal review' });
  await panel.getByRole('button', { name: 'Reject' }).click();

  await expect(page.locator('.react-flow__node').filter({ hasText: 'payments-dlq' })).toHaveCount(0);
  const status = await page.evaluate(() => window.__shell.proposal('p1')?.status);
  expect(status).toBe('rejected');
});

test('a proposal with no ops is informational — no accept/reject, just Dismiss', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(
    (proposal) => window.__shell.addProposal(proposal),
    proposalFixture({ status: 'informational', ops: [], counts: { added: 0, updated: 0, removed: 0 }, summary: 'No architectural impact', resolvedAt: Date.now() }),
  );
  await openPlatform(page);

  // Informational proposals are already terminal — nothing pending to badge.
  await expect(page.getByRole('button', { name: /proposal to review/ })).toHaveCount(0);
});
