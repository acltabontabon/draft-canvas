/**
 * Build + `vite preview` lifecycle for the benchmark harness — modeled on
 * `playwright.dist.config.ts`'s existing "build once, serve `dist/`, never dev/HMR" pattern, with
 * explicit health-polling and guaranteed teardown (no orphaned preview server after a run).
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLL_INTERVAL_MS = 300;
const READY_TIMEOUT_MS = 60_000;

export interface BenchServer {
  url: string;
  stop: () => Promise<void>;
}

export async function startBenchServer(opts: { port: number; skipBuild?: boolean }): Promise<BenchServer> {
  if (!opts.skipBuild) {
    execSync('npm run build', { stdio: 'inherit', cwd: REPO_ROOT });
  }

  const child: ChildProcess = spawn(
    'npm',
    ['run', 'preview', '--', '--port', String(opts.port), '--strictPort'],
    { cwd: REPO_ROOT, stdio: 'pipe', detached: true },
  );

  const url = `http://localhost:${opts.port}`;

  const stop = async () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already exited, or the process group is gone — nothing left to clean up.
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      setTimeout(finish, 2000);
    });
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) {
        return { url, stop };
      }
    } catch {
      // Server not up yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await stop();
  throw new Error(`Benchmark preview server did not become ready at ${url} within ${READY_TIMEOUT_MS}ms`);
}
