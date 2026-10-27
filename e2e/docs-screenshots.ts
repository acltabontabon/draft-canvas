import { openGallery } from './library';
import { boundaryDocument, node, recoveryDocument, trafficDocument } from './fixtures/traffic';
/**
 * Regenerates the screenshots the user guides in `docs/guides/` embed (`docs/media/guides/*.png`).
 *
 *   npx tsx e2e/docs-screenshots.ts
 *
 * It is not a test and is not run by `npm test` or `npm run e2e`. It drives the real UI through the
 * same steps the guides describe, so a UI change that breaks a guide's walkthrough fails here
 * instead of leaving a stale picture: nothing is faked and nothing reaches into the store.
 *
 * Runs its own dev server, and the dev collaboration relay (`scripts/dev-relay.mjs`) it points at, on
 * ports of their own (never 5180, which the e2e suite shares, and never
 * a name-based kill: this working copy is used by several sessions at once), in a light theme, and
 * a clean browser profile, so the Library it captures holds only what this script drew.
 *
 * The same walkthrough can be captured in the dark palette and kept somewhere else — one harness,
 * two palettes, rather than a second script that would drift:
 *
 *   npx tsx e2e/docs-screenshots.ts --theme dark --out <directory>
 *   npx tsx e2e/docs-screenshots.ts --technology-only
 *   npx tsx e2e/docs-screenshots.ts --rich-text-only
 *   npx tsx e2e/docs-screenshots.ts --collab-only
 *   npx tsx e2e/docs-screenshots.ts --empty-canvas-only
 *   npx tsx e2e/docs-screenshots.ts --traffic-only
 *
 * The guides' own set is what you get with no arguments, unchanged.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Browser, type Locator, type Page } from '@playwright/test';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const THEME = flag('theme') === 'dark' ? 'dark' : 'light';
const OUT = join(REPO_ROOT, flag('out') ?? 'docs/media/guides');
const PORT = 5391;
const RELAY_PORT = 8991;
const URL = `http://localhost:${PORT}`;
const VIEWPORT = { width: 1200, height: 640 };

const CANVAS = '.react-flow__pane';

/** Every starter in the catalog, in `docs/guides/examples.md`'s order — id for the file name, name as the palette lists it. */
const STARTERS: ReadonlyArray<readonly [string, string]> = [
  ['monolith', 'Monolith'],
  ['modular-monolith', 'Modular Monolith'],
  ['microservices', 'Microservices'],
  ['event-driven', 'Event-Driven'],
  ['hexagonal', 'Hexagonal'],
  ['bff', 'Backend for Frontend'],
  ['cqrs', 'CQRS'],
  ['medallion', 'Medallion'],
  ['kappa', 'Kappa'],
  ['cdc', 'Change Data Capture'],
  ['saga-orchestration', 'Saga – Orchestration'],
  ['saga-choreography', 'Saga – Choreography'],
  ['transactional-outbox', 'Transactional Outbox'],
];

const log = (line: string) => process.stdout.write(`${line}\n`);

async function startServer(): Promise<() => Promise<void>> {
  const child: ChildProcess = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    detached: true,
    env: { ...process.env, VITE_COLLAB_RELAY: `ws://localhost:${RELAY_PORT}` },
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const stop = async () => {
    if (child.pid === undefined || exited) return;
    try {
      process.kill(-child.pid, 'SIGTERM'); // the process group: `npm run dev` wraps vite
    } catch {
      // already gone
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`vite exited before it was ready. Is port ${PORT} in use?`);
    try {
      if ((await fetch(URL)).status < 500) return stop;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await stop();
  throw new Error(`No dev server at ${URL} after 90 s.`);
}

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  // Let motion settle (popovers, ghosts, camera) so the picture is the resting state.
  await page.waitForTimeout(1300);
  await page.screenshot({ path: join(OUT, `${name}.png`), clip });
  log(`  ${name}.png`);
}

/** A dialog on its own, without the dimmed editor behind it. */
async function shotDialog(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.getByRole('dialog').screenshot({ path: join(OUT, `${name}.png`) });
  log(`  ${name}.png`);
}

const box = async (locator: Locator) => (await locator.boundingBox())!;

async function nodeCentre(page: Page, index: number) {
  const b = await box(page.locator('.dc-node').nth(index));
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The pointer over the canvas, then a shape letter: the shape lands under it, ready to name. */
async function drop(page: Page, key: string, at: { x: number; y: number }, name: string) {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.press(key);
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
}

/** Where a shape's connectors leave or enter on one side: the middle of that side's three handles. */
async function sideY(page: Page, index: number, side: 'left' | 'right') {
  const boxes = await page.locator('.dc-node').nth(index).locator('.dc-handle').evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })),
  );
  const edge = side === 'left' ? Math.min(...boxes.map((b) => b.x)) : Math.max(...boxes.map((b) => b.x));
  const ys = boxes.filter((b) => Math.abs(b.x - edge) < 4).map((b) => b.y).sort((a, b) => a - b);
  return ys[Math.floor(ys.length / 2)]!;
}

/**
 * Nudges `to` up or down until the connector from `from` runs level. Shapes differ in height (a
 * queue's label hangs below its body), so dropping them at the same y leaves a jog in the line, which
 * reads as sloppy in a picture even though the app is right to draw it.
 */
async function levelWith(page: Page, from: number, to: number) {
  const dy = (await sideY(page, from, 'right')) - (await sideY(page, to, 'left'));
  if (Math.abs(dy) < 1) return;
  const target = page.locator('.dc-node').nth(to);
  await target.click({ position: { x: 8, y: 8 } });
  const key = dy < 0 ? 'ArrowUp' : 'ArrowDown';
  for (let i = 0; i < Math.floor(Math.abs(dy) / 10); i += 1) await page.keyboard.press(`Shift+${key}`);
  for (let i = 0; i < Math.round(Math.abs(dy) % 10); i += 1) await page.keyboard.press(key);
  // No Escape here: it would dismiss the suggestion ghost the selected shape is about to offer.
}

/** Clicks the line between two shapes, a little in from the first one: where a person would. */
async function clickConnector(page: Page, from: number, to: number) {
  const a = await box(page.locator('.dc-node').nth(from));
  const b = await box(page.locator('.dc-node').nth(to));
  const y = a.y + a.height / 2;
  const x = a.x + a.width + Math.min(28, (b.x - a.x - a.width) / 3);
  await page.mouse.click(x, y);
}

/** Drags from one shape's right-hand handle onto another shape. */
async function connectNodes(page: Page, from: number, to: number) {
  const source = page.locator('.dc-node').nth(from);
  await page.mouse.move(1, 1); // WebKit refreshes hover only on real movement (see e2e/canvas.ts)
  await source.hover();
  const handle = await box(source.locator('.dc-handle').nth(1));
  const target = await nodeCentre(page, to);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await levelWith(page, from, to);
}

/** Runs one palette command by name, the way a reader following the docs would. */
async function palette(page: Page, query: string) {
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeHidden();
}

/** The dev relay the session link knocks through, on a port of its own; resolves to its stop. */
async function startRelay(): Promise<() => void> {
  const child = spawn('node', ['scripts/dev-relay.mjs', '--port', String(RELAY_PORT)], { cwd: REPO_ROOT, stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => chunk.toString().includes('relay listening') && resolve());
    child.once('exit', () => reject(new Error(`The dev relay exited. Is port ${RELAY_PORT} in use?`)));
  });
  return () => void child.kill('SIGTERM');
}

/**
 * Collaborating: the owner starts a session, a second browser knocks with the session link, the owner
 * lets them in, and each sees the other's pointer and selection. A real session between two contexts.
 */
async function collabScreenshots(browser: Browser, page: Page) {
  log('collaborating');
  await page.getByRole('button', { name: 'New canvas' }).first().click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.locator(CANVAS).click({ position: { x: 8, y: 8 } });
  await palette(page, 'Microservices');
  await expect(page.locator('.dc-node').first()).toBeVisible();
  await page.getByLabel('Diagram title').fill('Shop platform');
  await page.keyboard.press('Enter');
  await page.locator(CANVAS).click({ position: { x: 8, y: 8 } });
  await palette(page, 'Fit to view');
  // The owner's own pointer rests on empty canvas, so no shape wears hover handles in the pictures.
  const rest = async () => page.mouse.move(VIEWPORT.width - 60, VIEWPORT.height - 120);

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  // The Share panel with the toolbar above it: every way the diagram reaches someone, spelled out.
  const panel = page.getByRole('menu', { name: 'Share' });
  await expect(panel).toBeVisible();
  await page.waitForTimeout(400);
  const menuBox = await box(panel);
  await page.screenshot({
    path: join(OUT, 'share-panel.png'),
    clip: { x: menuBox.x - 24, y: 0, width: VIEWPORT.width - menuBox.x + 24, height: menuBox.y + menuBox.height + 16 },
  });
  log('  share-panel.png');
  await page.getByRole('menuitem', { name: /^Draw together, live/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Collaborate' });
  await dialog.getByLabel('Your name').fill('Ada');
  // The dialogs are taller than the guides' usual window: show each whole, unscrolled.
  const tall = { width: VIEWPORT.width, height: 1100 };
  await page.setViewportSize(tall);
  await page.waitForTimeout(900); // the scene draws itself in
  await shotDialog(page, 'collab-start');
  // The privacy seal, opened: what leaves the browser, and the STUN server setting.
  await dialog.getByRole('button', { name: 'How your diagram stays private' }).click();
  await shotDialog(page, 'collab-privacy');
  // A STUN server nothing answers (TEST-NET-1): the two browsers on this machine need none.
  await dialog.getByText('Use your own STUN server').click();
  await dialog.getByLabel('Server').fill('stun:192.0.2.1:3478');
  await dialog.getByRole('button', { name: 'Start session' }).click();
  const link = dialog.getByRole('textbox', { name: 'Session link' });
  await expect(link).toHaveValue(/#join=2\./, { timeout: 15_000 });
  await page.mouse.move(8, 8);
  await page.getByRole('dialog').evaluate((element) => element.querySelector('.dc-modal-body')?.scrollTo(0, 0));
  await page.waitForTimeout(900);
  await shotDialog(page, 'collab-session');
  const sessionLink = await link.inputValue();
  await page.keyboard.press('Escape');
  await page.setViewportSize(VIEWPORT);

  const guestContext = await browser.newContext({ viewport: tall, deviceScaleFactor: 2, colorScheme: THEME });
  const guest = await guestContext.newPage();
  try {
    await guest.goto(sessionLink);
    const join = guest.getByRole('dialog', { name: 'Join a live session' });
    await join.getByLabel('Your name').fill('Grace');
    await guest.waitForTimeout(900);
    await shotDialog(guest, 'collab-join');
    await join.getByRole('button', { name: 'Ask to join' }).click();
    await guest.setViewportSize(VIEWPORT);
    await expect(page.getByRole('group', { name: 'Grace is asking to join' })).toBeVisible({ timeout: 15_000 });
    await rest();
    await shot(page, 'collab-door');

    await page.getByRole('group', { name: 'Grace is asking to join' }).getByRole('button', { name: 'Let in' }).click();
    await expect(guest.locator('.dc-editor')).toBeVisible({ timeout: 30_000 });
    // Framed like the owner's view, so Grace's pointer lands where the picture can show it.
    await guest.locator(CANVAS).click({ position: { x: 8, y: 8 } });
    await palette(guest, 'Fit to view');
    await guest.waitForTimeout(600);
    const held = await box(guest.locator('.dc-node', { hasText: 'Capability B Service' }));
    await guest.mouse.click(held.x + held.width / 2, held.y + 10);
    await guest.mouse.move(held.x + held.width + 30, held.y + held.height + 24, { steps: 4 });
    await expect(page.locator('.dc-presence-cursor').filter({ hasText: 'Grace' })).toBeVisible({ timeout: 10_000 });
    await rest();
    await shot(page, 'collab-live');

    // The owner ends it: Grace's canvas closes behind the card that says so.
    await page.getByRole('button', { name: /^Live session/ }).click();
    await dialog.getByRole('button', { name: 'End session' }).click();
    await page.keyboard.press('Escape');
    await expect(guest.getByRole('dialog', { name: 'Ada ended the session' })).toBeVisible({ timeout: 15_000 });
    await guest.mouse.move(8, 8);
    await guest.waitForTimeout(1400); // with `shot`'s own wait: the line snips, the seat empties, the postmark lands
    await shot(guest, 'collab-ended');
  } finally {
    await guestContext.close();
  }
}

async function technologyScreenshots(page: Page) {
  await page.getByRole('button', { name: 'New canvas' }).first().click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const title = page.getByLabel('Diagram title');
  await title.fill('Technology at a glance');
  await title.blur();
  await drop(page, 'd', { x: 420, y: 310 }, 'Orders');
  await page.locator('.dc-element-inspector').getByRole('button', { name: 'Add technology' }).click();
  const technology = page.getByRole('combobox', { name: 'Technology', exact: true });
  await technology.fill('Postgres');
  await expect(page.getByRole('option', { name: 'PostgreSQL', exact: true })).toBeVisible();
  await shot(page, 'technology-suggestions');
  await page.getByRole('option', { name: 'PostgreSQL', exact: true }).click();
  await page.locator(CANVAS).click({ position: { x: 12, y: 12 } });

  await drop(page, 's', { x: 720, y: 310 }, 'Internal worker');
  await page.locator('.dc-element-inspector').getByRole('button', { name: 'Add technology' }).click();
  await technology.fill('Private runtime');
  await technology.press('Enter');
  await page.locator(CANVAS).click({ position: { x: 12, y: 12 } });
  const generic = page.getByRole('button', { name: 'Technology: Private runtime', exact: true });
  await generic.click();
  await expect(page.locator('.dc-technology-detail:visible')).toHaveText('Private runtime');
  await generic.press('Escape');
  await page.locator(CANVAS).click({ position: { x: 12, y: 12 } });
  await page.mouse.move(80, 80);
  await shot(page, 'technology-generic');
}

/** Markdown a developer would put beside an architecture: an API's checklist and latencies, the code
 *  a box stands for, and the warnings that go with it. */
const RICH_TEXT = [
  '## Checkout API\nHandles **payments** with `idempotency keys`.\n\n- [x] Rate limiting\n- [ ] Circuit breaker\n\n| Endpoint | p99 |\n| --- | ---: |\n| `POST /orders` | 120 ms |\n| `GET /orders/:id` | 18 ms |',
  '```ts\nexport async function charge(order: Order) {\n  const key = order.id; // idempotent\n  return stripe.charge({ amount, key });\n}\n```\n\n```diff\n- timeout: 30s\n+ timeout: 5s\n```',
  '> [!WARNING]\n> Never call **Ledger** synchronously from the hot path.\n\n> [!TIP]\n> Publish through the ==outbox== instead.',
];

/** A Text shape dropped at `at`, its Markdown typed in (inserted, so Enter's list continuation stays
 *  out of it), committed, then widened by its corner handle by `widen` pixels. */
async function richText(page: Page, at: { x: number; y: number }, markdown: string, widen: number) {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.press('t');
  await page.keyboard.insertText(markdown);
  await page.keyboard.press('Escape');
  const corner = await box(page.locator('.react-flow__resize-control.handle.bottom.right').first());
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + widen, corner.y + corner.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function richTextScreenshots(page: Page) {
  await page.getByRole('button', { name: 'New canvas' }).first().click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const title = page.getByLabel('Diagram title');
  await title.fill('Checkout notes');
  await title.blur();
  await richText(page, { x: 150, y: 120 }, RICH_TEXT[0]!, 80);
  await richText(page, { x: 470, y: 120 }, RICH_TEXT[1]!, 170);
  await richText(page, { x: 920, y: 120 }, RICH_TEXT[2]!, 30);
  await richText(page, { x: 960, y: 400 }, 'Ship it **Friday**', 0);
  // Its look, from the shape's own Aa panel: a marker-pen note.
  await page.locator('.dc-element-inspector').getByRole('button', { name: 'Text style' }).click();
  await page.getByRole('button', { name: 'Hand font' }).click();
  await page.getByRole('button', { name: 'Marker background' }).click();
  await page.locator(CANVAS).click({ position: { x: 12, y: 12 } });
  await page.mouse.move(20, 600);
  const canvas = await box(page.locator(CANVAS));
  await shot(page, 'rich-text', { ...canvas, height: 470 });

  // The same shape being edited: its Markdown source, and the format bar in its popover.
  await page.locator('.dc-node').first().dblclick();
  await expect(page.getByRole('toolbar', { name: 'Format text' })).toBeVisible();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  // Framed on the editor and its bar together, wherever the popover chose to sit.
  await page.waitForTimeout(600);
  const editor = await box(page.locator('.dc-node[data-editing]'));
  const bar = await box(page.locator('.dc-element-inspector'));
  const left = Math.max(0, Math.min(editor.x, bar.x) - 24);
  const top = Math.max(0, Math.min(editor.y, bar.y) - 24);
  const right = Math.max(editor.x + editor.width, bar.x + bar.width) + 24;
  const bottom = Math.max(editor.y + editor.height, bar.y + bar.height) + 24;
  await shot(page, 'rich-text-editing', { x: left, y: top, width: right - left, height: bottom - top });
  await page.keyboard.press('Escape');
}

async function trafficScreenshots(page: Page) {
  await page.setViewportSize({ width: 1440, height: 860 });
  const document = trafficDocument('Online store');
  document.nodes = [
    node('gateway', 'service', 'Web Storefront', 0, 0, { serviceKind: 'api' }),
    node('mobile', 'service', 'Mobile BFF', 0, 240, { serviceKind: 'api' }),
    node('checkout', 'service', 'Checkout', 360, 160),
    node('billing', 'service', 'Catalog', 360, -100),
    node('postgres', 'database', 'PostgreSQL', 760, 40, { databaseKind: 'sql' }),
    node('stripe', 'service', 'Stripe', 760, 300, { serviceKind: 'external' }),
    node('paypal', 'service', 'PayPal', 760, 440, { serviceKind: 'external' }),
  ];
  document.edges.push(
    { id: 'checkout-stripe', source: 'checkout', target: 'stripe', directed: true, routing: 'smoothstep', semantic: 'calls' },
    { id: 'checkout-paypal', source: 'checkout', target: 'paypal', directed: true, routing: 'smoothstep', semantic: 'calls' },
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: 'traffic-guide.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.locator('.dc-status-traffic').click();
  await expect(page.locator('button.dc-traffic-note').last()).toHaveCSS('opacity', '1', { timeout: 10000 });
  await shot(page, 'traffic-overview');
  const fallback = page.getByRole('button', { name: /^no fallback!/ }).first();
  await fallback.click();
  await shot(page, 'traffic-note');
  await fallback.press('Escape');
  await page.locator('.react-flow__node[data-id="checkout"] .dc-node').click();
  await expect(page.locator('.dc-traffic-callout')).toBeVisible();
  await shot(page, 'traffic-detail');
  await page.locator('.dc-traffic-callout').screenshot({ path: join(OUT, 'traffic-callout.png') });
  log('  traffic-callout.png');
  await page.locator('.dc-traffic-work summary').click();
  await page.getByRole('list', { name: 'Work per arrival' }).scrollIntoViewIfNeeded();
  await shot(page, 'traffic-work');
  await page.getByRole('button', { name: 'How to read this' }).click();
  await shot(page, 'traffic-reading-guide');
  await page.goto(URL);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'recovery-guide.draftcanvas', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(recoveryDocument())),
  });
  await page.locator('.dc-status-traffic').click();
  await page.locator('.react-flow__node[data-id="dlq"] .dc-node').click();
  await page.locator('.dc-traffic-recovery summary').click();
  await page.getByRole('textbox', { name: 'Messages to replay' }).fill('500');
  await shot(page, 'traffic-recovery');
  await page.locator('.react-flow__node[data-id="db"] .dc-node').click();
  await page.locator('.dc-traffic-database summary').click();
  await shot(page, 'traffic-database');
  await page.goto(URL);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'boundary-guide.draftcanvas', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(boundaryDocument())),
  });
  await page.locator('.dc-status-traffic').click();
  await page.locator('.react-flow__node[data-id="deployment"] .dc-node').click({ position: { x: 20, y: 15 } });
  await shot(page, 'traffic-boundaries');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  log(`${THEME} theme -> ${OUT}`);
  const stopRelay = await startRelay();
  const stop = await startServer();
  // Chromium hides this machine's addresses from WebRTC behind mDNS names; the two browsers of the
  // collaboration pictures connect over plain host addresses instead.
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: THEME,
      acceptDownloads: true,
    });
    const page = await context.newPage();
    await page.goto(URL);

    if (process.argv.includes('--traffic-only')) {
      await trafficScreenshots(page);
      return;
    }

    if (process.argv.includes('--empty-canvas-only')) {
      await page.getByRole('button', { name: 'New canvas', exact: true }).click();
      await expect(page.locator('.dc-editor')).toBeVisible();
      await shot(page, 'empty-canvas');
      return;
    }
    if (process.argv.includes('--technology-only')) {
      await technologyScreenshots(page);
      return;
    }
    if (process.argv.includes('--rich-text-only')) {
      await richTextScreenshots(page);
      return;
    }
    if (process.argv.includes('--collab-only')) {
      await collabScreenshots(browser, page);
      return;
    }

    // ── Getting started ────────────────────────────────────────────────────────────────────
    log('getting started');
    await page.setViewportSize({ width: VIEWPORT.width, height: 900 });
    await shot(page, 'home');
    await page.setViewportSize(VIEWPORT);
    await page.getByRole('button', { name: 'New canvas' }).first().click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    await shot(page, 'empty-canvas');
    const title = page.getByLabel('Diagram title');
    await title.fill('Order processing');
    await title.blur();

    await drop(page, 's', { x: 200, y: 260 }, 'Orders API');
    await expect(page.locator('.dc-node')).toHaveCount(1);

    // Drag from the service's right-hand handle into empty space: the Quick Connect menu.
    const service = page.locator('.dc-node').first();
    await service.click();
    const handle = await box(service.locator('.dc-handle').nth(1));
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(480, 260, { steps: 12 });
    await page.mouse.up();
    await shot(page, 'quick-connect');
    await page.getByRole('menuitem', { name: /Queue/ }).first().click();
    // A shape made from the drop menu opens ready to name, like any other new shape.
    await page.keyboard.type('orders');
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node')).toHaveCount(2);
    await levelWith(page, 0, 1);

    // The ghost worker appears beside the selected queue; Tab takes it.
    await page.locator('.dc-node').nth(1).click();
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'service');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('consumed by');
    await shot(page, 'suggestion');
    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Fulfilment worker');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await levelWith(page, 1, 2);
    await page.mouse.click(700, 560);
    await expect(page.locator('.dc-edge text')).toContainText(['sends command to', 'consumed by']);
    await shot(page, 'service-queue-worker');

    // A note, docked on the queue.
    await drop(page, 'n', { x: 420, y: 470 }, 'Buffers order bursts so the API stays fast');
    await page.keyboard.press('Escape');
    const note = page.locator('.dc-node[data-type="note"]').first();
    const noteBox = await box(note);
    const queueBox = await box(page.locator('.dc-node[data-type="queue"]').first());
    await page.mouse.move(noteBox.x + noteBox.width / 2, noteBox.y + 8);
    await page.mouse.down();
    await page.mouse.move(queueBox.x + queueBox.width / 2, queueBox.y + queueBox.height / 2, { steps: 20 });
    await page.waitForTimeout(1200); // held over the queue until it docks
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await shot(page, 'note-docked');

    // An open point: raised on the API in two clicks, then the list it can be picked up from.
    await page.locator('.dc-node').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add open point…' }).click();
    await expect(page.locator('.dc-open-point-popover')).toBeVisible();
    await shot(page, 'open-point-raise');
    await page.getByRole('button', { name: 'Tentative' }).click();
    await page.keyboard.type('We think this call is asynchronous — the fulfilment team still has to confirm.');
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 560);
    await page.locator('.dc-status-open-points').click();
    await expect(page.locator('.dc-open-points')).toBeVisible();
    await shot(page, 'open-point-review');
    await page.keyboard.press('Escape');

    // Two connectors become a flow.
    await clickConnector(page, 0, 1);
    const inspector = page.locator('.dc-edge-inspector');
    await expect(inspector.getByRole('button', { name: 'Add to flow' })).toBeVisible();
    await shot(page, 'add-to-flow');
    await inspector.getByRole('button', { name: 'Add to flow' }).click();
    // The flow's name field opens with its default selected, so typing replaces it.
    await page.keyboard.type('Place an order');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.locator('.dc-edge text', { hasText: 'consumed by' }).click({ force: true });
    await inspector.getByRole('button', { name: 'Add to Place an order' }).click();
    await page.mouse.click(700, 560); // empty canvas: deselect, leaving the Flows panel open
    await shot(page, 'flows-panel');

    // Presenting: the opening, then the first step once its signal has settled.
    await page.getByRole('button', { name: 'Present', exact: true }).click();
    await shot(page, 'presenting-opening');
    await page.keyboard.press('Space');
    await page.waitForTimeout(1400);
    await shot(page, 'presenting');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Export.
    await page.setViewportSize({ ...VIEWPORT, height: 900 });
    await page.keyboard.press('Control+Shift+e');
    await expect(page.getByRole('dialog')).toBeVisible();
    await shotDialog(page, 'export-image');
    await page.getByRole('dialog').getByText('Document', { exact: true }).click();
    await shotDialog(page, 'export-document');
    await page.getByRole('dialog').getByText('Share', { exact: true }).click();
    await shotDialog(page, 'export-share');
    await page.keyboard.press('Escape');
    await page.setViewportSize(VIEWPORT);

    // ── Keyboard and the command palette ───────────────────────────────────────────────────
    log('keyboard');
    await page.locator(CANVAS).click({ position: { x: 700, y: 520 } });
    await page.keyboard.press('Control+k');
    await page.keyboard.type('queue');
    await expect(page.getByRole('dialog')).toBeVisible();
    await shotDialog(page, 'command-palette');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+/');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.setViewportSize({ width: VIEWPORT.width, height: 1000 }); // the sheet scrolls; show all of it
    await shotDialog(page, 'shortcut-sheet');
    await page.setViewportSize(VIEWPORT);
    await page.keyboard.press('Escape');

    // ── Depth ──────────────────────────────────────────────────────────────────────────────
    log('depth');
    await page.getByRole('button', { name: /Back to your diagrams/ }).click();
    await openGallery(page);
    await page.getByRole('button', { name: 'New canvas' }).first().click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    const title2 = page.getByLabel('Diagram title');
    await title2.fill('Shop overview');
    await title2.blur();
    await drop(page, 'a', { x: 120, y: 260 }, 'Customer');
    await drop(page, 's', { x: 440, y: 260 }, 'Shop');
    await drop(page, 's', { x: 780, y: 260 }, 'Payment provider');
    await connectNodes(page, 0, 1);
    await connectNodes(page, 1, 2);
    await page.mouse.click(600, 500);
    await shot(page, 'depth-overview');

    await page.locator('.dc-node').nth(1).click();
    await page.keyboard.press('Control+ArrowDown');
    await expect(page.getByText('What runs inside Shop?')).toBeVisible();
    await shot(page, 'look-inside-empty');
    await drop(page, 's', { x: 200, y: 260 }, 'Shop API');
    await drop(page, 'd', { x: 620, y: 260 }, 'Orders DB');
    await connectNodes(page, 0, 1);
    await page.mouse.click(600, 500);
    await page.getByRole('navigation', { name: 'Depth' }).hover();
    await shot(page, 'depth-map');
    await page.mouse.move(700, 450);

    await page.keyboard.press('Control+k');
    await page.keyboard.type('View level');
    await page.keyboard.press('Enter');
    await expect(page.getByText('This view shows')).toBeVisible();
    await shotDialog(page, 'view-level');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+ArrowUp');

    // ── The Library ────────────────────────────────────────────────────────────────────────
    log('library');
    await page.getByRole('button', { name: /Back to your diagrams/ }).click();
    await openGallery(page);
    await expect(page.getByText('Order processing')).toBeVisible();
    await shot(page, 'library');

    // ── Architecture examples ──────────────────────────────────────────────────────────────
    // One picture per starter, each on its own fresh canvas, framed by "Fit to view" so the picture
    // is the whole architecture and not wherever the camera happened to be. Names are typed into the
    // palette exactly as `docs/guides/examples.md` lists them, so a renamed starter breaks here first.
    log('examples');
    for (const [id, name] of STARTERS) {
      await page.getByRole('button', { name: 'New canvas' }).first().click();
      await expect(page.locator('.dc-editor')).toBeVisible();
      // The pane has to hold focus for the palette's chord, as in the keyboard section above.
      await page.locator(CANVAS).click({ position: { x: 8, y: 8 } });
      await palette(page, name);
      await expect(page.locator('.dc-node').first()).toBeVisible();
      await page.locator(CANVAS).click({ position: { x: 8, y: 8 } }); // nothing selected in the picture
      await palette(page, 'Fit to view');
      await shot(page, `example-${id}`, await box(page.locator(CANVAS)));
      await page.getByRole('button', { name: /Back to your diagrams/ }).click();
      await openGallery(page);
      await expect(page.getByRole('button', { name: 'New canvas' }).first()).toBeVisible();
    }

    await technologyScreenshots(page);
    log('rich text');
    await page.getByRole('button', { name: /Back to your diagrams/ }).click();
    await openGallery(page);
    await richTextScreenshots(page);
    await page.getByRole('button', { name: /Back to your diagrams/ }).click();
    await openGallery(page);
    await collabScreenshots(browser, page);
    await context.close();
  } finally {
    await browser.close();
    await stop();
    stopRelay();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
