/**
 * Regenerates the screenshots the user guides in `docs/guides/` embed (`docs/media/guides/*.png`).
 *
 *   npx tsx e2e/docs-screenshots.ts
 *
 * It is not a test and is not run by `npm test` or `npm run e2e`. It drives the real UI through the
 * same steps the guides describe, so a UI change that breaks a guide's walkthrough fails here
 * instead of leaving a stale picture: nothing is faked and nothing reaches into the store.
 *
 * Runs its own dev server on a port of its own (never 5180, which the e2e suite shares, and never
 * a name-based kill: this working copy is used by several sessions at once), in a light theme, and
 * a clean browser profile, so the Library it captures holds only what this script drew.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Locator, type Page } from '@playwright/test';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, 'docs/media/guides');
const PORT = 5391;
const URL = `http://localhost:${PORT}`;
const VIEWPORT = { width: 1200, height: 640 };

const CANVAS = '.react-flow__pane';

const log = (line: string) => process.stdout.write(`${line}\n`);

async function startServer(): Promise<() => Promise<void>> {
  const child: ChildProcess = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    detached: true,
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const stop = await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: 'light',
      acceptDownloads: true,
    });
    const page = await context.newPage();
    await page.goto(URL);

    // ── Getting started ────────────────────────────────────────────────────────────────────
    log('getting started');
    await page.getByRole('button', { name: 'New canvas' }).first().click();
    await expect(page.locator('.dc-editor')).toBeVisible();
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
    // A shape made from the drop menu is selected but not yet being named: Enter starts that.
    await page.keyboard.press('Enter');
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
    await expect(page.locator('.dc-edge text')).toContainText(['publishes to', 'consumed by']);
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

    // Two connectors become a flow.
    await clickConnector(page, 0, 1);
    const inspector = page.locator('.dc-edge-inspector');
    await expect(inspector.getByText('Add to flow', { exact: true })).toBeVisible();
    await shot(page, 'add-to-flow');
    await inspector.getByText('Add to flow', { exact: true }).click();
    // The flow's name field opens with its default selected, so typing replaces it.
    await page.keyboard.type('Place an order');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.locator('.dc-edge text', { hasText: 'consumed by' }).click({ force: true });
    await inspector.getByText('Add to Place an order', { exact: true }).click();
    await page.mouse.click(700, 560); // empty canvas: deselect, leaving the Flows panel open
    await shot(page, 'flows-panel');

    // Presenting.
    await page.getByRole('button', { name: 'Present', exact: true }).click();
    await shot(page, 'presenting');
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Export.
    await page.keyboard.press('Control+Shift+e');
    await expect(page.getByRole('dialog')).toBeVisible();
    await shotDialog(page, 'export-image');
    await page.getByRole('dialog').getByText('Document', { exact: true }).click();
    await shotDialog(page, 'export-document');
    await page.keyboard.press('Escape');

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
    await expect(page.getByText('Order processing')).toBeVisible();
    await shot(page, 'library');

    await context.close();
  } finally {
    await browser.close();
    await stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
