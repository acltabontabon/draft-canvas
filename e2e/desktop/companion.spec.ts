import { expect, test, type Page } from '@playwright/test';
import { installMockShell } from './mockShell';
import { chooseWorkFile } from './explorer';

/**
 * The agent companion in the real editor, against the mock shell: the person opens it, asks about
 * what they selected, watches the run the shell reports, and reviews the proposal it ends with.
 */

test.beforeEach(async ({ page }) => {
  await installMockShell(page);
});

const DIAGRAM = 'd_open00000001';

const ORDERS = {
  requestId: 'companion-1',
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

/** `setup` runs once the page is loaded, before the diagram opens (and the editor asks the shell). */
async function openOrders(page: Page, setup?: () => Promise<unknown>, { readOnly = false, project = true } = {}) {
  await page.goto('/');
  if (project) await page.evaluate(() => window.__shell.seed({ projects: [{ name: 'work', path: '~/work', agent: true, diagrams: [] }] }));
  await setup?.();
  const text = await page.evaluate(async (orders) => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const load = (path: string) => import(/* @vite-ignore */ path) as Promise<any>;
    const { compose } = await load('/src/agent/compile.ts');
    return compose(orders, 'd_open00000001').text;
  }, ORDERS);
  await page.evaluate(
    ({ text, readOnly }) => {
      const handle = window.__shell.addFile('Order processing', text);
      window.__shell.file(handle)!.readOnly = readOnly;
    },
    { text, readOnly },
  );
  await page.evaluate(() => window.__shell.setAgent({ enabled: true, listening: true }));
  await page.getByRole('button', { name: 'Open file…' }).click();
  await chooseWorkFile(page, 'Order processing');
  await expect(page.locator('.dc-editor')).toBeVisible();
}

test('token breakdown stays visible after click and keyboard focus, within the viewport', async ({ page }) => {
  await openOrders(page);
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  const input = page.getByLabel('Message Claude Code');
  await input.fill('Explain this diagram');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(1);
  await page.evaluate(() => {
    const run = window.__shell.companionSent()[0]!.runId;
    window.__shell.emit({ type: 'companion', run, event: { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'An order flows from API to queue, worker and database.', costMicroUsd: null, usage: { input: 1000, cached: 600, output: 100 } } });
  });
  const count = page.getByRole('button', { name: 'Token usage: 500 new tokens so far' });
  const tooltip = page.getByRole('tooltip').filter({ hasText: 'Token usage' });
  await count.click();
  await page.mouse.move(20, 180);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('Cached input');
  await expect(count).toBeFocused();
  await expect(tooltip).toHaveCSS('opacity', '1');
  const geometry = await tooltip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, opacity: style.opacity, visibility: style.visibility, innerWidth, innerHeight };
  });
  expect(geometry.width).toBeGreaterThan(100);
  expect(geometry.height).toBeGreaterThan(100);
  expect(geometry.x).toBeGreaterThanOrEqual(0);
  expect(geometry.y).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.innerWidth);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.innerHeight);
  expect(geometry.opacity).toBe('1');
  expect(geometry.visibility).toBe('visible');
  await page.screenshot({ path: test.info().outputPath('token-breakdown-click.png') });
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  // WebKit ports differ in which controls participate in Tab traversal. Establish keyboard
  // modality, then focus the trigger directly: this verifies the app's focus/blur behavior rather
  // than assuming a browser/OS Tab sequence returns to the same button (Linux CI did not).
  await expect(input).toBeVisible();
  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.press('Shift');
  await count.focus();
  await expect(count).toBeFocused();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveCSS('opacity', '1');
  await page.screenshot({ path: test.info().outputPath('token-breakdown-focus.png') });
  await input.focus();
  await expect(input).toBeFocused();
  await expect(tooltip).toBeHidden();
});

test('asks about the selection, follows the run in the bubble, and accepts its proposal on the canvas', async ({ page }) => {
  await openOrders(page);
  const rest = page.getByRole('button', { name: 'Open Nodi' });
  await expect(rest).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('companion-resting.png') });

  await page.locator('.react-flow__node').filter({ hasText: 'Orders database' }).click();
  await page.keyboard.press('ControlOrMeta+j');
  const input = page.getByLabel('Message Claude Code');
  await expect(input).toBeFocused();
  await expect(page.locator('.dc-companion-chip')).toHaveText('Orders database');
  await page.screenshot({ path: test.info().outputPath('companion-open.png') });
  // Left out and brought back with the chip itself.
  await page.getByRole('button', { name: 'Ask about the whole view instead' }).click();
  await expect(page.getByLabel('Message Claude Code')).toHaveAttribute('placeholder', 'Ask about the whole view…');
  await page.screenshot({ path: test.info().outputPath('companion-left-out.png') });
  await page.getByRole('button', { name: 'Ask about Orders database' }).click();
  await expect(page.locator('.dc-companion-chip')).not.toHaveAttribute('data-off', 'true');

  await input.fill('Put a cache in front of this');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(1);
  const sent = await page.evaluate(() => window.__shell.companionSent()[0]!);
  expect(sent).toMatchObject({ diagramId: DIAGRAM, text: 'Put a cache in front of this', mode: 'proposal' });
  expect((sent.selection as { nodes: string[] }).nodes).toHaveLength(1);

  // The page made the run id; the shell's events come back under it.
  const runId = sent.runId;
  const send = (event: Record<string, unknown>) => page.evaluate(([run, event]) => window.__shell.emit({ type: 'companion', run, event }), [runId, event] as const);
  await send({ type: 'started', session: 's-1' });
  await send({ type: 'tool-call', id: 't1', tool: 'read_diagram', status: 'in-progress' });
  // The bubble is the conversation, shown as it goes: what was asked, and each step the agent takes.
  const conversation = page.getByRole('region', { name: 'Conversation with Claude Code' });
  await expect(conversation).toContainText('Put a cache in front of this');
  await expect(conversation).toContainText('Reading the diagram');
  await expect(page.getByRole('img', { name: 'Nodi, working' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('companion-working.png') });

  await send({ type: 'tool-call-update', id: 't1', status: 'completed', error: null });
  await send({ type: 'tool-call', id: 't2', tool: 'submit_proposal', status: 'in-progress' });
  await send({ type: 'tool-call-update', id: 't2', status: 'completed', error: null });
  await send({ type: 'message-chunk', text: 'I proposed a cache-aside Orders cache: the worker reads it first, falls back to the database on a miss and fills it. Writes evict the order’s entry.\n\nStill open:\n- How stale may an order be?\n- Is the database the bottleneck on reads or on writes?' });
  await page.evaluate(
    ([diagramId, run]) =>
      window.__shell.addProposal({
        proposalId: 'p-cache',
        version: 1,
        diagramId,
        path: [],
        status: 'pending',
        baseRevision: 'o:seed.0',
        // A whole cache-aside design, as the brief asks for: read, miss, fill, the write policy, and a
        // flow that walks the read path.
        ops: [
          {
            op: 'add',
            nodes: [{ id: 'cache', type: 'cache', label: 'Orders cache' }],
            relationships: [{ id: 'r4', from: 'w', to: 'cache', label: '1. Read first, 3. fill' }],
            notes: [{ id: 'n1', about: 'cache', kind: 'decision', text: 'Cache-aside. Entries live 5 minutes; a write updates the database, then evicts that order’s entry.' }],
            flows: [
              {
                id: 'f-read',
                title: 'Read an order (cache-aside)',
                steps: [
                  { relationship: 'r4', caption: 'Look in the cache first' },
                  { relationship: 'r3', caption: 'On a miss, read the database' },
                  { spotlight: ['cache', 'r4'], caption: 'Fill the cache for next time' },
                ],
              },
            ],
          },
          { op: 'update', id: 'r3', set: { label: '2. Miss · writes' } },
        ],
        layout: null,
        preconditions: { nodes: {}, edges: {} },
        counts: { added: 3, updated: 1, removed: 0 },
        summary: 'Cache-aside Orders cache: read first, fill on a miss, evict on write',
        rationale: '',
        assumptions: [],
        openQuestions: [],
        sourceRef: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
        stale: false,
        run,
      }),
    [DIAGRAM, runId] as const,
  );
  // The shell says a proposal arrived, as it does on every submit.
  await page.evaluate(() => window.__shell.emit({ type: 'agent-changed' }));
  await send({ type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: 41200, usage: { input: 60_953, cached: 30_392, output: 114 } });

  const speech = page.locator('.dc-companion-speech');
  await expect(speech).toContainText('I proposed a cache-aside Orders cache');
  await expect(page.getByRole('region', { name: 'Proposed change' })).toContainText('Cache-aside Orders cache');
  // Reviewed on the canvas, beside the dashed change, not in a panel of its own.
  const review = page.getByRole('region', { name: 'Proposed change' });
  await expect(review).toContainText('read first, fill on a miss, evict on write');
  const accept = review.getByRole('button', { name: 'Accept' });
  await expect(accept).toBeEnabled();
  await expect(page.getByRole('img', { name: 'Nodi, waiting for you' }).first()).toBeVisible();
  // What the conversation has used, as it adds up; with a subscription sign-in, no dollar figure.
  await expect(page.locator('.dc-companion-spent')).toContainText('31k new tokens so far');
  await expect(speech).not.toContainText('$0.04');
  // The camera eases the change into view, and the chip follows it: judged where both settle.
  const ghost = page.locator('.dc-agent-preview').getByText('Orders cache').first();
  await expect
    .poll(async () => {
      const [chip, shape] = await Promise.all([review.boundingBox(), ghost.boundingBox()]);
      return chip && shape ? Math.abs(chip.x - shape.x) < 400 : false;
    })
    .toBe(true);
  await page.waitForTimeout(600);
  await page.screenshot({ path: test.info().outputPath('companion-review.png') });

  // Accepted where it is: one commit, recorded as accepted, and the mascot says so.
  await accept.click();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Orders cache' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__shell.proposal('p-cache')?.status)).toBe('accepted');
  await expect(speech).toContainText('Added to the diagram');
  // The whole exchange is there, with no toggle to find it.
  await expect(page.getByRole('region', { name: 'Conversation with Claude Code' })).toContainText('Put a cache in front of this');
  await expect(page.locator('.dc-companion-spent')).toContainText('31k new tokens so far');
  await page.screenshot({ path: test.info().outputPath('companion-thread.png') });
  await expect(review).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('companion-accepted.png') });
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Orders cache' })).toHaveCount(0);
});

test('a tidy-up is shown on tracing paper: the proposed diagram on one sheet, trails from where shapes stand', async ({ page }) => {
  await openOrders(page);
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  const input = page.getByLabel('Message Claude Code');
  // (A bare "tidy this up" is the app's own Arrange command now, offered by Nodi without the agent.)
  await input.fill('Move the database under the API so the worker’s connector is short');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(1);
  const runId = await page.evaluate(() => window.__shell.companionSent()[0]!.runId);
  const send = (event: Record<string, unknown>) => page.evaluate(([run, event]) => window.__shell.emit({ type: 'companion', run, event }), [runId, event] as const);
  await send({ type: 'started', session: 's-2' });
  await send({ type: 'message-chunk', text: 'I proposed a tidier layout: the database sits under the API, so the worker’s connector no longer runs the length of the diagram.' });
  await page.evaluate(
    ([diagramId, run]) =>
      window.__shell.addProposal({
        proposalId: 'p-tidy',
        version: 1,
        diagramId,
        path: [],
        status: 'pending',
        baseRevision: 'o:seed.0',
        ops: [{ op: 'update', id: 'db', set: { place: { below: 'api', gap: 96 } } }],
        layout: null,
        preconditions: { nodes: {}, edges: {} },
        counts: { added: 0, updated: 1, removed: 0 },
        summary: 'Move the database under the API',
        rationale: '',
        assumptions: [],
        openQuestions: [],
        sourceRef: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
        stale: false,
        run,
      }),
    [DIAGRAM, runId] as const,
  );
  await page.evaluate(() => window.__shell.emit({ type: 'agent-changed' }));
  await send({ type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null });

  const review = page.getByRole('region', { name: 'Proposed change' });
  await expect(review.getByRole('button', { name: 'Accept' })).toBeEnabled();
  // One sheet, never each shape twice: the moved shape trails back to where it stands now.
  const sheet = page.locator('.dc-agent-preview[data-mode="sheet"]');
  const paper = sheet.locator('.dc-preview-sheet');
  await expect(paper).toBeVisible();
  await expect(sheet.locator('.dc-preview-was')).toHaveCount(1);
  await expect(sheet.locator('.dc-preview-trails line')).toHaveCount(1);
  await page.waitForTimeout(600);
  await page.screenshot({ path: test.info().outputPath('companion-tidy-proposed.png') });

  // Lift the sheet to compare with the diagram as it is.
  await review.getByText('Now', { exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('companion-tidy-now.png') });
  await review.getByText('Proposed', { exact: true }).click();
  await expect(paper).toBeVisible();
});

test('a proposal honors its layout direction, and a short confirmation continues the agent conversation', async ({ page }) => {
  await openOrders(page);
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  const input = page.getByLabel('Message Claude Code');
  await input.fill('Draw me a vertical version of this architecture');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(1);
  const run = await page.evaluate(() => window.__shell.companionSent()[0]!.runId);
  await page.evaluate(({ diagramId, run }) => {
    window.__shell.addProposal({
      proposalId: 'p-vertical', version: 1, diagramId, run, path: [], status: 'pending',
      baseRevision: 'o:seed.0', ops: [{ op: 'arrange' }],
      layout: { direction: 'down', spacing: 'spacious' },
      preconditions: { nodes: {}, edges: {} }, counts: { added: 0, updated: 4, removed: 0, arranged: 7 },
      summary: 'Arrange the diagram vertically', rationale: '', assumptions: [], openQuestions: [],
      sourceRef: null, createdAt: Date.now(), updatedAt: Date.now(), resolvedAt: null, stale: false,
    });
    window.__shell.emit({ type: 'agent-changed' });
    window.__shell.emit({ type: 'companion', run, event: { type: 'message-chunk', text: 'I proposed a vertical layout. Shall I reorganize its inside too?' } });
    window.__shell.emit({ type: 'companion', run, event: { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null } });
  }, { diagramId: DIAGRAM, run });
  const review = page.getByRole('region', { name: 'Proposed change' });
  await expect(page.locator('.dc-agent-preview[data-mode="sheet"] .dc-preview-sheet')).toBeVisible();
  await expect(review.getByRole('button', { name: 'Accept' })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('companion-vertical-layout.png') });
  await review.getByRole('button', { name: 'Accept' }).click();
  await expect(review).toBeHidden();
  const boxes = await Promise.all(['api', 'q', 'w', 'db'].map((id) => page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox()));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.y).toBeGreaterThan(boxes[i - 1]!.y + boxes[i - 1]!.height);
  await input.fill('yes');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(2);
  expect(await page.evaluate(() => window.__shell.companionSent()[1]!.text)).toBe('yes');
  await page.evaluate(() => {
    const run = window.__shell.companionSent()[1]!.runId;
    window.__shell.emit({ type: 'companion', run, event: { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'Shall I change it?', costMicroUsd: null, usage: null } });
  });
  await input.fill('do it change it');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(3);
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
});

test('an answer about the diagram is pinned on it: numbered points on their parts, lit together', async ({ page }) => {
  await openOrders(page);
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  const input = page.getByLabel('Message Claude Code');
  await input.fill('What are the risks here?');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(1);
  const runId = await page.evaluate(() => window.__shell.companionSent()[0]!.runId);
  const send = (event: Record<string, unknown>) => page.evaluate(([run, event]) => window.__shell.emit({ type: 'companion', run, event }), [runId, event] as const);
  await send({ type: 'started', session: 's-3' });
  await send({
    type: 'message-chunk',
    text: [
      'The main risks, in order of how much they matter:',
      '',
      '- **Hot reads on one database.** Every order read goes from [[w]] to [[db]] over [[r3]]: it takes the whole read load.',
      '- **No dead-letter path.** A message [[w]] can never process is retried forever from [[q]].',
      '- [[api]] publishes after it answers, so a failed publish loses the order silently.',
    ].join('\n'),
  });
  await send({ type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: { input: 48_169, cached: 30_000, output: 400 } });

  // The parts are named as the diagram names them, never as ids.
  const speech = page.locator('.dc-companion-speech');
  await expect(speech.getByRole('button', { name: 'Orders database' })).toBeVisible();
  await expect(speech).not.toContainText('[[');
  // One numbered pin per point, on the first part it names.
  const pins = page.locator('.dc-companion-pin');
  await expect(pins).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Point 1, about Fulfilment worker, Orders database, reads / writes' })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: test.info().outputPath('companion-points.png') });

  // A pin lights its point in the bubble and its parts on the canvas.
  await pins.nth(0).hover();
  await expect(speech.locator('[data-point="1"]')).toHaveAttribute('data-hot', 'true');
  await expect(page.locator('.dc-node[data-pointed="true"]')).toHaveCount(2);
  await expect(page.locator('.dc-edge[data-pointed="true"]')).toHaveCount(1);
  await page.waitForTimeout(250);
  await page.screenshot({ path: test.info().outputPath('companion-points-hover.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(250);
  await page.screenshot({ path: test.info().outputPath('companion-points-hover-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  // And the bubble's point lights its pin.
  await speech.locator('[data-point="2"]').hover();
  await expect(pins.nth(1)).toHaveAttribute('data-hot', 'true');
  await expect(page.locator('.dc-node[data-pointed="true"]')).toHaveCount(2);
  // A pin opens the conversation at its point.
  await pins.nth(2).click();
  await expect(page.getByRole('region', { name: 'Conversation with Claude Code' }).locator('[data-point="3"]')).toBeInViewport();
  // Nothing about it is the document's: closing Nodi takes the pins and the light away.
  await page.getByRole('button', { name: 'Hide Nodi' }).click();
  await expect(pins).toHaveCount(0);
  await expect(page.locator('[data-pointed="true"]')).toHaveCount(0);
});

test('at rest Nodi speaks up: a greeting on arrival, what it is doing, and news it has', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openOrders(page);
  // It walks on first, then says hello under its own name.
  await expect(page.getByRole('img', { name: 'Nodi, on the way' })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath('nodi-walking.png') });
  const say = page.locator('.dc-companion-say');
  await expect(say).toBeVisible();
  await expect(say).toHaveAttribute('data-tone', 'greet');
  await expect(say).toContainText('Click to chat');
  await expect(say).toHaveAccessibleName(/^Nodi: /);
  // The hello is about the diagram that just opened.
  await expect(say).toHaveAccessibleName(/Order processing/);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: test.info().outputPath('nodi-greeting.png') });

  // Asked, then closed while it works: it keeps saying what it is on.
  await say.click();
  await expect(page.getByRole('list', { name: 'Ask Nodi' }).getByRole('button')).toHaveCount(3);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: test.info().outputPath('nodi-open.png') });
  const input = page.getByLabel('Message Claude Code');
  await input.fill('What are the risks here?');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(1);
  const runId = await page.evaluate(() => window.__shell.companionSent()[0]!.runId);
  const send = (event: Record<string, unknown>) => page.evaluate(([run, event]) => window.__shell.emit({ type: 'companion', run, event }), [runId, event] as const);
  await send({ type: 'started', session: 's-4' });
  await send({ type: 'tool-call', id: 't1', tool: 'read_diagram', status: 'in-progress' });
  await page.getByRole('button', { name: 'Hide Nodi' }).click();
  await expect(say).toHaveAttribute('data-tone', 'working');
  await expect(say).toHaveAccessibleName(/… reading the diagram\./);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: test.info().outputPath('nodi-working.png') });

  // Finished while closed: news, until it is read.
  await send({ type: 'message-chunk', text: 'Two risks: the database takes every read, and nothing catches a poison message.' });
  await send({ type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null });
  await expect(say).toHaveAttribute('data-tone', 'done');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: test.info().outputPath('nodi-done.png') });
  await say.click();
  await expect(page.locator('.dc-companion-speech')).toContainText('Two risks');
  await page.getByRole('button', { name: 'Hide Nodi' }).click();
  // Read: back to quiet, speaking only when hovered, and lingering a moment after the pointer goes.
  await page.getByRole('button', { name: 'Open Nodi' }).hover();
  await expect(say).toBeVisible();
  const line = await say.getAttribute('aria-label');
  await page.mouse.move(10, 10);
  await page.waitForTimeout(1500);
  await expect(say).toBeVisible();
  // Back during the linger: the same line, not a new one mid-read.
  await page.getByRole('button', { name: 'Open Nodi' }).hover();
  await expect(say).toHaveAttribute('aria-label', line!);
  await page.mouse.move(10, 10);
  await expect(say).toBeHidden({ timeout: 5000 });
});

test('with no agent on the computer Nodi still helps, and says what it can’t do', async ({ page }) => {
  await openOrders(page, () =>
    page.evaluate(() => window.__shell.setCompanionAgents([{ agent: 'claude-code', name: 'Claude Code', availability: 'missing', version: null, signIn: { loggedIn: false, method: null, transcripts: null } }])),
  );
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  await expect(page.locator('.dc-companion-speech')).toContainText('No coding agent on this computer');
  await expect(page.locator('.dc-companion-footer')).toContainText('no coding agent');
  // What it can answer itself, it does.
  await page.getByRole('list', { name: 'Ask Nodi' }).getByRole('button', { name: 'What’s in this diagram?' }).click();
  const conversation = page.getByRole('region', { name: /Conversation with/ });
  await expect(conversation).toContainText('Order processing');
  // What needs an agent, it says so, without trying to run one.
  const input = page.getByLabel('Message Claude Code');
  await input.fill('Add a cache in front of the database');
  await input.press('Enter');
  await expect(conversation).toContainText('Claude Code or Codex');
  expect(await page.evaluate(() => window.__shell.companionSent().length)).toBe(0);
});

test('stop asks the shell to end the run', async ({ page }) => {
  await openOrders(page);
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  const input = page.getByLabel('Message Claude Code');
  await input.fill('Explain this diagram');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(1);
  const runId = await page.evaluate(() => window.__shell.companionSent()[0]!.runId);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => page.evaluate(() => window.__shell.companionCancelled())).toEqual([runId]);
  await page.evaluate((run) => window.__shell.emit({ type: 'companion', run, event: { type: 'stopped', reason: { kind: 'cancelled' }, summary: null, costMicroUsd: null, usage: null } }), runId);
  await expect(page.locator('.dc-companion-speech')).toContainText('Stopped.');
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
});

test('asking whether I can delete a selected shape does not delete it', async ({ page }) => {
  await openOrders(page);
  await page.locator('.react-flow__node[data-id="api"]').click();
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  const input = page.getByLabel('Message Claude Code');
  await input.fill('could I delete that?');
  await input.press('Enter');
  const conversation = page.getByRole('region', { name: 'Conversation with Claude Code' });
  await expect(conversation.getByRole('button', { name: /Delete/ }).first()).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await expect(page.locator('.react-flow__node[data-id="api"]')).toBeVisible();
  expect(await page.evaluate(() => window.__shell.companionSent())).toHaveLength(0);
});

/** Nodi's box while it can't take a message: its line, and the next steps as replies, with nothing to
 *  type into. Shot whole, in the dark theme, for the record. */
async function expectBlocked(page: Page, says: string | RegExp, shot: string) {
  const box = page.locator('.dc-companion-speech');
  await expect(box).toContainText(says);
  await expect(page.getByRole('img', { name: 'Nodi, not set up' }).first()).toBeVisible();
  await expect(page.getByLabel('Message Claude Code')).toHaveCount(0);
  await expect(page.locator('.dc-companion-composer')).toHaveCount(0);
  await expect(page.locator('.dc-companion-footer')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath(`${shot}.png`) });
  return box;
}

/** The composer and its footer, back once nothing is in the way. */
async function expectChatting(page: Page) {
  await expect(page.getByLabel('Message Claude Code')).toBeVisible();
  await expect(page.locator('.dc-companion-footer')).toContainText('Review changes first');
}

test('without agent access it asks to be let in, right there', async ({ page }) => {
  // Typed out at once, so the shot has the whole line.
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await openOrders(page);
  await page.evaluate(() => window.__shell.setAgent({ enabled: false, listening: false }));
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  const box = await expectBlocked(page, 'Agent access is off, boss', 'nodi-blocked-access-off');
  // The first step lets Nodi in: the person's click is the decision, with no trip to Settings.
  const step = box.getByRole('button', { name: 'Let Nodi in' });
  await expect(step).toBeFocused();
  // Settings is still one click away.
  await box.getByRole('button', { name: 'Open agent settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('tab', { name: 'AI agents' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await box.getByRole('button', { name: 'Let Nodi in' }).click();
  // Switched on: the composer and footer are back.
  await expectChatting(page);
});

test('a quick draft is saved to a folder from Nodi’s box, and then it can chat', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.evaluate(() => {
    window.__shell.seed({ projects: [{ name: 'work', path: '~/work', agent: true, diagrams: [] }] });
    window.__shell.addFile('Notes', '{}');
    window.__shell.setAgent({ enabled: true, listening: true });
  });
  await page.getByRole('button', { name: 'New Quick Draft' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  const box = await expectBlocked(page, 'quick draft, boss', 'nodi-blocked-quick-draft');
  // The app's own first Save: the same dialog ⌘S opens.
  await box.getByRole('button', { name: 'Save it to a folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save diagram as', exact: true });
  await dialog.getByRole('option', { name: 'work', exact: true }).dblclick();
  await dialog.getByRole('textbox', { name: 'File name', exact: true }).fill('Sketch');
  await dialog.getByRole('button', { name: 'Save diagram', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectChatting(page);
});

for (const colorScheme of ['dark', 'light'] as const) {
  test(`an unregistered folder is set up from Nodi before an agent runs (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await openOrders(page, () => page.evaluate(() => window.__shell.seed({ explorer: [{ name: 'Other', path: '~/Other', diagrams: [] }] })), { project: false });
    await page.getByRole('button', { name: 'Open Nodi' }).click();
    const box = await expectBlocked(page, 'folder isn’t a project yet', `nodi-blocked-no-project-${colorScheme}`);
    await expect(box).toContainText('~/work');
    const add = box.getByRole('button', { name: 'Add project…' });
    await expect(add).toBeFocused();
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', { name: 'Add a project', exact: true });
    await expect(picker).toBeVisible();
    // Cancelling leaves the diagram and its access untouched.
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(add).toBeVisible();
    await expect(page.getByLabel('Message Claude Code')).toHaveCount(0);
    // Adding an unrelated folder doesn't clear the blocker or grant access to it.
    await add.click();
    await picker.getByRole('option', { name: 'Other', exact: true }).dblclick();
    await picker.getByRole('button', { name: 'Add project', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(add).toBeVisible();
    await expect(page.getByLabel('Message Claude Code')).toHaveCount(0);
    // Register the actual folder, then explicitly allow it in Nodi's box.
    await add.click();
    await picker.getByRole('option', { name: 'work', exact: true }).dblclick();
    await picker.getByRole('button', { name: 'Add project', exact: true }).click();
    await expect(picker).toBeHidden();
    const allow = box.getByRole('button', { name: /Allow work$/ });
    await expect(allow).toBeFocused();
    expect(await page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'agent_configure'))).toEqual([]);
    expect(await page.evaluate(() => window.__shell.companionSent())).toEqual([]);
    await page.keyboard.press('Enter');
    await expectChatting(page);
    const input = page.getByLabel('Message Claude Code');
    await expect(input).toBeFocused();
    await input.fill('What are the risks here?');
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__shell.companionSent().length)).toBe(1);
    await expect(box).not.toContainText('It fell over');
    const grants = await page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'agent_configure'));
    expect(grants).toHaveLength(1);
  });
}

test('a read-only file offers a copy through Save As, and the copy can chat', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await openOrders(page, undefined, { readOnly: true });
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  const box = await expectBlocked(page, 'read-only, boss', 'nodi-blocked-read-only');
  await box.getByRole('button', { name: 'Save a copy' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save diagram as', exact: true });
  await dialog.getByRole('option', { name: 'work', exact: true }).dblclick();
  await dialog.getByRole('textbox', { name: 'File name', exact: true }).fill('Order processing copy');
  await dialog.getByRole('button', { name: 'Save diagram', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectChatting(page);
});

test('an agent that is too old or signed out gets the command to fix it, copied', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  // What reaches the clipboard, whatever the browser's permissions.
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
  });
  const claude = { agent: 'claude-code', name: 'Claude Code', availability: 'installed', version: '2.1.0', signIn: { loggedIn: true, method: 'claude.ai', transcripts: null } };
  await openOrders(page, () => page.evaluate((agent) => window.__shell.setCompanionAgents([{ ...agent, availability: 'too-old', version: '1.0.3' }]), claude));
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  let box = await expectBlocked(page, 'Your Claude Code 1.0.3 is too old for me, boss', 'nodi-blocked-too-old');
  await box.getByRole('button', { name: 'Copy the update command' }).click();
  await expect(box).toContainText('Copied “claude update”. Paste it into Terminal, boss.');
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(['claude update']);

  // The agents are found once per app run: a new one for the signed-out agent.
  await openOrders(page, () => page.evaluate((agent) => window.__shell.setCompanionAgents([{ ...agent, signIn: { loggedIn: false, method: null, transcripts: null } }]), claude));
  await page.getByRole('button', { name: 'Open Nodi' }).click();
  box = await expectBlocked(page, 'Claude Code isn’t signed in yet, boss. Run claude once in Terminal to sign in', 'nodi-blocked-signed-out');
  await box.getByRole('button', { name: 'Copy the sign-in command' }).click();
  await expect(box).toContainText('Copied “claude”.');
});
