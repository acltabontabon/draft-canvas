/**
 * Environment fingerprinting — what machine/browser/commit produced a report, so results carry
 * honest "measured on this machine" context whether the run was local or CI. No special-casing
 * between the two: it's just a description of whatever machine ran it.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkEnvironment } from './types';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function collectEnvironment(browserVersion: string): Promise<BenchmarkEnvironment> {
  const cpuList = cpus();
  return {
    os: platform(),
    osVersion: release(),
    arch: arch(),
    cpuModel: cpuList[0]?.model ?? 'unknown',
    cpuCount: cpuList.length,
    totalMemoryMiB: Math.round(totalmem() / (1024 * 1024)),
    browser: 'chromium',
    browserVersion,
    nodeVersion: process.version,
  };
}

export function getDraftCanvasVersion(): string {
  const raw = readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? 'unknown';
}

export function getGitInfo(): { commit: string; branch: string } {
  let commit = 'unknown';
  let branch = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch {
    // Not a git checkout, or git unavailable — 'unknown' is an honest answer.
  }
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch {
    // Same as above.
  }
  return { commit, branch };
}
