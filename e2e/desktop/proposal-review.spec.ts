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

  // Redo restores exactly the accepted result — the proposal record itself never re-enters the
  // picture (there's no "un-redo" of a resolution), it's purely the document's own undo stack.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('.react-flow__node').filter({ hasText: 'payments-dlq' })).toBeVisible();
  expect(await page.evaluate(() => window.__shell.proposal('p1')?.status)).toBe('accepted');
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

test('the canvas ghost shows an addition, a cascaded removal, and a modified connector', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(
    (proposal) => window.__shell.addProposal(proposal),
    proposalFixture({
      ops: [
        { op: 'add', nodes: [{ id: 'dlq', type: 'dead-letter-queue', label: 'payments-dlq', group: 'core' }], relationships: [{ id: 'r5', from: 'q', to: 'dlq', label: 'After 5 attempts' }] },
        { op: 'remove', ids: ['db'], cascade: true },
        { op: 'update', id: 'r3', set: { label: 'Enqueue payment' } },
      ],
      counts: { added: 2, updated: 1, removed: 2 },
    }),
  );
  await openPlatform(page);

  await page.getByRole('button', { name: '1 proposal to review' }).click();
  const panel = page.getByRole('region', { name: 'Proposal review' });
  await expect(panel).toBeVisible();

  // The removed node ('Orders DB') and its cascaded edge ('r2') both get a ghost treatment.
  const ghost = page.locator('.dc-agent-preview');
  await expect(ghost.locator('.dc-agent-preview-removed')).toHaveCount(1);
  await expect(ghost.locator('.dc-ghost-node')).toHaveCount(1); // the added dead-letter queue
  const edgePaths = ghost.locator('.dc-ghost-edges path');
  await expect(edgePaths).toHaveCount(3); // the added r5, the removed r2, and the modified r3
  // Removed edge: found by its distinct stroke, which must be a real literal colour, not a bare
  // `var(...)` string sitting inert in the attribute (`theme.danger`, a literal per-theme hex, is
  // what the removed treatment actually uses — see `ContinuationGhost.tsx`).
  const strokes = await edgePaths.evaluateAll((els) => els.map((el) => el.getAttribute('stroke')));
  const edgeColor = await ghost.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dc-edge').trim());
  const removedStroke = strokes.find((s) => s && s !== edgeColor);
  expect(removedStroke).toBeTruthy();
  expect(removedStroke).toMatch(/^#[0-9a-f]{6}$/i);
  const removedEdge = ghost.locator(`.dc-ghost-edges path[stroke="${removedStroke}"]`);
  await expect(removedEdge).toHaveCount(1);
  // The arrowhead it points to must actually exist in `<defs>` — a `marker-end` referencing a colour
  // `Markers.tsx` never registered resolves to nothing, and the browser silently drops the arrowhead
  // rather than erroring, so this has to be checked explicitly, not inferred from the path rendering.
  const markerId = await removedEdge.evaluate((el) => el.getAttribute('marker-end')?.match(/url\(#([^)]+)\)/)?.[1]);
  expect(markerId).toBeTruthy();
  await expect(page.locator(`marker#${markerId}`)).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('proposal-ghost-canvas.png') });
});

test('the canvas ghost gives a removed boundary the same treatment as a removed element', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(
    (proposal) => window.__shell.addProposal(proposal),
    proposalFixture({
      ops: [{ op: 'remove', ids: ['core'], cascade: true }],
      counts: { added: 0, updated: 0, removed: 5 },
    }),
  );
  await openPlatform(page);

  await page.getByRole('button', { name: '1 proposal to review' }).click();
  await expect(page.getByRole('region', { name: 'Proposal review' })).toBeVisible();

  // The boundary itself plus its four cascaded members (api, db, q, w) all get the removed treatment.
  await expect(page.locator('.dc-agent-preview .dc-agent-preview-removed')).toHaveCount(5);
});

test('"Focus changes" pans the camera toward the proposed change, clear of the panel', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((proposal) => window.__shell.addProposal(proposal), proposalFixture());
  await openPlatform(page);
  await page.getByRole('button', { name: '1 proposal to review' }).click();

  const panel = page.getByRole('region', { name: 'Proposal review' });
  const before = await page.evaluate(() => document.querySelector('.react-flow__viewport')?.getAttribute('style'));
  await panel.getByRole('button', { name: 'Focus changes' }).click();
  await expect
    .poll(async () => page.evaluate(() => document.querySelector('.react-flow__viewport')?.getAttribute('style')))
    .not.toBe(before);
});

test('the panel and its ghost stay legible in dark theme and at a small window', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await page.evaluate(
    (proposal) => window.__shell.addProposal(proposal),
    proposalFixture({
      ops: [
        { op: 'add', nodes: [{ id: 'dlq', type: 'dead-letter-queue', label: 'payments-dlq', group: 'core' }] },
        { op: 'remove', ids: ['db'], cascade: true },
      ],
      counts: { added: 1, updated: 0, removed: 2 },
    }),
  );
  await openPlatform(page);
  await page.getByRole('button', { name: '1 proposal to review' }).click();

  const panel = page.getByRole('region', { name: 'Proposal review' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Accept' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('proposal-dark.png') });

  // Actions must stay reachable without scrolling even in a short window.
  await page.setViewportSize({ width: 900, height: 420 });
  await expect(panel.getByRole('button', { name: 'Accept' })).toBeInViewport();
  await expect(panel.getByRole('button', { name: 'Reject' })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('proposal-dark-narrow.png') });
});

test('a proposal stuck "accepting" whose own ids already exist offers "Mark as applied", not a plain conflict', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(
    (proposal) => window.__shell.addProposal(proposal),
    proposalFixture({
      status: 'accepting',
      // 'db' already exists in the live document (crash simulated: the add committed, the record didn't) —
      // replaying this op against it is exactly the DUPLICATE_ID fingerprint Case B looks for.
      ops: [{ op: 'add', nodes: [{ id: 'db', type: 'sql-database', label: 'Orders DB' }] }],
      counts: { added: 1, updated: 0, removed: 0 },
    }),
  );
  await openPlatform(page);
  await page.getByRole('button', { name: '1 proposal to review' }).click();

  const panel = page.getByRole('region', { name: 'Proposal review' });
  await expect(panel).toContainText('This looks like it already applied');
  await expect(panel.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  const markApplied = panel.getByRole('button', { name: 'Mark as applied' });
  await expect(markApplied).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('proposal-already-applied.png') });

  await markApplied.click();
  await expect(page.getByRole('button', { name: /proposal to review/ })).toHaveCount(0);
  const status = await page.evaluate(() => window.__shell.proposal('p1')?.status);
  expect(status).toBe('accepted');
  // No document mutation happened — the node count is exactly what the platform fixture already had.
  await expect(page.locator('.react-flow__node')).toHaveCount(PLATFORM.nodes.length + PLATFORM.groups.length);
});

test('a proposal stuck "accepting" whose id merely collides with something unrelated is a plain conflict, never "Mark as applied"', async ({ page }) => {
  // Same shape as the "Mark as applied" case above, except the live node at the colliding id has a
  // *different* label — this proposal's own add never actually landed; something else entirely grabbed
  // the id 'db' in the meantime. Offering "Mark as applied" here would silently discard this proposal's
  // real, un-applied change (regression for the content-verification fix in `looksAlreadyApplied`).
  await page.goto('/');
  await page.evaluate(
    (proposal) => window.__shell.addProposal(proposal),
    proposalFixture({
      status: 'accepting',
      ops: [{ op: 'add', nodes: [{ id: 'db', type: 'sql-database', label: 'A totally different database' }] }],
      counts: { added: 1, updated: 0, removed: 0 },
    }),
  );
  await openPlatform(page);
  await page.getByRole('button', { name: '1 proposal to review' }).click();

  const panel = page.getByRole('region', { name: 'Proposal review' });
  await expect(panel).not.toContainText('This looks like it already applied');
  await expect(panel.getByRole('button', { name: 'Mark as applied' })).toHaveCount(0);
  await expect(panel).toContainText('Recovering from an interrupted accept');
  await expect(panel.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reject' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Accept' })).toBeDisabled();
});

test('a proposal targeting a nested room reviews and applies there, not at the root (regression for 9f5f9c3)', async ({ page }) => {
  const NESTED_PLATFORM = {
    requestId: 'watch-nested-1',
    title: 'Nested platform',
    nodes: [
      {
        id: 'api',
        type: 'api',
        label: 'Checkout API',
        inside: {
          nodes: [{ id: 'inner-svc', type: 'service', label: 'Pricing module' }],
          relationships: [],
        },
      },
    ],
    relationships: [],
  };
  await page.goto('/');
  await page.evaluate(
    (proposal) => window.__shell.addProposal(proposal),
    proposalFixture({
      path: ['api'],
      ops: [{ op: 'add', nodes: [{ id: 'inner-new', type: 'service', label: 'Discount module' }], relationships: [{ id: 'inner-r1', from: 'inner-svc', to: 'inner-new', label: 'Applies' }] }],
      counts: { added: 2, updated: 0, removed: 0 },
    }),
  );
  const text = await page.evaluate(async (platform) => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const load = (path: string) => import(/* @vite-ignore */ path) as Promise<any>;
    const { compose } = await load('/src/agent/compile.ts');
    return compose(platform, 'd_open00000001').text;
  }, NESTED_PLATFORM);
  await page.evaluate((text) => {
    const added = window.__shell.addFile('Nested platform', text);
    window.__shell.nextOpen(added);
  }, text);
  await page.getByRole('button', { name: 'Open file…' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();

  // Reviewing from the root: the proposal targets a room one level down, so nothing in it should be
  // mistaken for a root-level change, and the panel should say where it actually applies.
  await page.getByRole('button', { name: '1 proposal to review' }).click();
  const panel = page.getByRole('region', { name: 'Proposal review' });
  await expect(panel).toContainText('Targets');
  await expect(panel).toContainText('Checkout API');
  await expect(panel.locator('.dc-proposal-diff-added')).toHaveCount(2);
  // "Focus changes" would pan to the nested room's own local coordinates, meaningless while looking
  // at the root — must stay disabled rather than jump the camera somewhere arbitrary.
  await expect(panel.getByRole('button', { name: 'Focus changes' })).toBeDisabled();

  await panel.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByRole('button', { name: /proposal to review/ })).toHaveCount(0);
  // Still at the root — accepting a nested-room proposal must never switch the person's view.
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Checkout API' })).toBeVisible();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Discount module' })).toHaveCount(0);

  // Drill into the room the proposal actually targeted, and find the new node there.
  await page.locator('.react-flow__node').filter({ hasText: 'Checkout API' }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+ArrowDown');
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Discount module' })).toBeVisible();
});

test('a duplicate-id conflict from a sibling proposal disables Accept — never shown as acceptable (reproduces the reported symptom)', async ({ page }) => {
  // The reported symptom was a duplicate-ID error alongside an apparently-enabled Accept button.
  // `ProposalPanel`'s Accept is gated on a fresh dry run (`disabled={... || !!dryRunProblem ...}`),
  // so the two proposals below — both declaring the same new id — should make this impossible: once
  // the first is accepted, the second's Accept must go (and stay) disabled, not merely show an error
  // alongside a clickable button.
  await page.goto('/');
  await page.evaluate(
    (proposals) => proposals.forEach((p) => window.__shell.addProposal(p)),
    [
      proposalFixture({ proposalId: 'p1', ops: [{ op: 'add', nodes: [{ id: 'dlq', type: 'dead-letter-queue', label: 'payments-dlq', group: 'core' }] }], counts: { added: 1, updated: 0, removed: 0 } }),
      proposalFixture({
        proposalId: 'p2',
        summary: 'A second, independent proposal that also wants a dead-letter queue',
        ops: [{ op: 'add', nodes: [{ id: 'dlq', type: 'dead-letter-queue', label: 'payments-dlq-2', group: 'core' }] }],
        counts: { added: 1, updated: 0, removed: 0 },
      }),
    ],
  );
  await openPlatform(page);

  await page.getByRole('button', { name: '2 proposals to review' }).click();
  const panel = page.getByRole('region', { name: 'Proposal review' });
  // Each row is a `role="listitem"` button (its explicit role wins over "button" for accessible-name
  // lookups), so it's found by list-item role, not button role.
  await panel.getByRole('listitem').filter({ hasText: 'Add a dead-letter queue after the payments queue' }).click();
  await panel.getByRole('button', { name: 'Accept' }).click();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'payments-dlq' }).first()).toBeVisible();

  // Select the second, still-pending proposal — its own dry run now collides with the id 'p1' just created.
  await panel.getByRole('listitem').filter({ hasText: 'A second, independent proposal' }).click();
  await expect(panel).toContainText('already used');
  await expect(panel.getByRole('button', { name: 'Accept' })).toBeDisabled();
  // Confirms it's not merely visually disabled — clicking it (if it were somehow enabled) must do nothing.
  await panel.getByRole('button', { name: 'Accept' }).click({ force: true });
  await expect(page.locator('.react-flow__node').filter({ hasText: 'payments-dlq-2' })).toHaveCount(0);
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
