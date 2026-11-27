/**
 * Captures Settings → AI agents through the real desktop UI with the fake shell, one image per
 * agent and state. Run manually: npx tsx e2e/desktop/agent-settings-shots.ts --out <folder>
 * `--guide` also refreshes the guide's own image (docs/media/guides/agent-setup-codex.png).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page } from '@playwright/test';
import { installMockShell } from './mockShell';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.SHOTS_PORT ?? 5207);
const BASE_URL = `http://localhost:${PORT}`;
const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? null : process.argv[at + 1];
};
const OUT = arg('--out') ?? join(ROOT, 'test-results/agent-settings');
const GUIDE = process.argv.includes('--guide');
const NAME_SHIM = 'globalThis.__name ||= (fn) => fn;';

async function startServer(): Promise<() => Promise<void>> {
  const child = spawn('npm', ['run', 'dev', '--', '--mode', 'desktop', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'pipe', detached: true });
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

async function open(page: Page) {
  await page.addInitScript({ content: NAME_SHIM });
  await installMockShell(page);
  await page.addInitScript(() =>
    window.__shell.seed({
      projects: [
        { name: 'storefront', diagrams: [] },
        { name: 'checkout', path: 'storefront/checkout', diagrams: [] },
      ],
    }),
  );
  await page.goto(BASE_URL);
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'settings' }));
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'AI agents' }).click();
  await settings.getByRole('switch', { name: 'Allow agent access' }).check();
  await settings.getByRole('group', { name: 'Allowed folders' }).getByRole('checkbox', { name: /^storefront/ }).check();
  await page.evaluate(() => document.fonts.ready);
  return settings;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const stop = await startServer();
  const browser = await chromium.launch();
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.on('pageerror', (error) => process.stderr.write(`${error.stack ?? error.message}\n`));
      const settings = await open(page);
      const shot = async (name: string, path = join(OUT, `${name}-${scheme}.png`)) => {
        await page.mouse.move(8, 8);
        await page.waitForTimeout(250);
        await page.screenshot({ path, animations: 'disabled' });
        process.stdout.write(`Captured ${path}\n`);
      };
      const connect = settings.getByRole('heading', { name: 'Connect an agent' });
      await shot('page-top');
      await connect.scrollIntoViewIfNeeded();
      for (const agent of ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'Junie', 'OpenCode', 'Other MCP clients']) {
        const slug = agent.toLowerCase().replace(/\s+/g, '-');
        await settings.getByRole('radio', { name: agent }).check({ force: true });
        await connect.evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await shot(`connect-${slug}`);
        if (GUIDE && scheme === 'light' && agent === 'Codex') await shot('guide', join(ROOT, 'docs/media/guides/agent-setup-codex.png'));
        const add = settings.getByRole('button', { name: `Add to ${agent}` });
        if (await add.count()) {
          await add.click();
          await expect(add).toHaveCount(0);
          await connect.evaluate((el) => el.scrollIntoView({ block: 'start' }));
          await shot(`connected-${slug}`);
        }
        if (agent === 'OpenCode') {
          // Every step done: the skill installed, and an agent that has made its first request.
          await settings.getByRole('button', { name: 'Install skill' }).click();
          await page.evaluate(() => window.__shell.setAgent({ connections: 1 }));
          await expect(settings.getByText('1 agent connected.')).toBeVisible();
          await connect.evaluate((el) => el.scrollIntoView({ block: 'start' }));
          await shot('done-opencode');
          await page.evaluate(() => window.__shell.setAgent({ connections: 0 }));
        }
      }
      await context.close();
    }
    // The compact window the app can be resized to.
    const context = await browser.newContext({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const settings = await open(page);
    await settings.getByRole('heading', { name: 'Connect an agent' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await settings.getByRole('radio', { name: 'OpenCode' }).check({ force: true });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(OUT, 'connect-opencode-compact.png'), animations: 'disabled' });
    await context.close();
  } finally {
    await browser.close();
    await stop();
  }
}

await main();
