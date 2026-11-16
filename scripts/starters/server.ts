/**
 * The dev server the starters scripts render in: a port of its own (never 5180, which the e2e suite
 * shares), stopped by killing exactly the process group it started.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 5394;
export const SERVER_URL = `http://localhost:${PORT}`;
const URL = SERVER_URL;

export async function startServer(): Promise<() => Promise<void>> {
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
    await new Promise((done) => setTimeout(done, 500));
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`vite exited before it was ready. Is port ${PORT} in use?`);
    try {
      if ((await fetch(URL)).status < 500) return stop;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 300));
  }
  await stop();
  throw new Error(`No dev server at ${URL} after 90 s.`);
}
