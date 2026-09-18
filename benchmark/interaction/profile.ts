/**
 * CPU profiles for a scenario, reduced to the functions that matter. Frame times say *that* a
 * commit took 125 ms; a profile says what it was spent on. Best read against a build made with
 * `vite build --minify false`, so function names survive — the numbers are the same code, just
 * legible.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession } from '@playwright/test';

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
}

interface CpuProfile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

export async function startProfile(cdp: CDPSession, intervalUs = 200): Promise<void> {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: intervalUs });
  await cdp.send('Profiler.start');
}

export async function stopProfile(cdp: CDPSession): Promise<CpuProfile> {
  const { profile } = await cdp.send('Profiler.stop');
  return profile as unknown as CpuProfile;
}

export interface FunctionTime {
  name: string;
  where: string;
  selfMs: number;
  inclusiveMs: number;
}

const label = (frame: ProfileNode['callFrame']) => {
  const file = frame.url.split('/').pop() ?? frame.url;
  return {
    name: frame.functionName || '(anonymous)',
    where: `${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`,
  };
};

/** Self and inclusive milliseconds per function, biggest first. Idle and program time are dropped. */
export function summarizeProfile(profile: CpuProfile, top = 30): { totalMs: number; functions: FunctionTime[] } {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfUs = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i]!;
    selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }

  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

  const key = (node: ProfileNode) => {
    const { name, where } = label(node.callFrame);
    return `${name}@${where}`;
  };
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let total = 0;

  for (const [id, us] of selfUs) {
    const node = byId.get(id)!;
    const name = node.callFrame.functionName;
    if (name === '(idle)' || name === '(program)' || name === '(root)') continue;
    total += us;
    const own = key(node);
    self.set(own, (self.get(own) ?? 0) + us);
    // Inclusive time is charged once per distinct function on the stack, so recursion and repeated
    // frames do not count a sample twice.
    const seen = new Set<string>();
    let cursor: number | undefined = id;
    while (cursor !== undefined) {
      const frame = byId.get(cursor)!;
      const k = key(frame);
      if (!seen.has(k)) {
        seen.add(k);
        inclusive.set(k, (inclusive.get(k) ?? 0) + us);
      }
      cursor = parent.get(cursor);
    }
  }

  const rows: FunctionTime[] = [...inclusive.entries()].map(([k, us]) => {
    const [name = '', where = ''] = k.split('@');
    return { name, where, selfMs: (self.get(k) ?? 0) / 1000, inclusiveMs: us / 1000 };
  });
  rows.sort((a, b) => b.inclusiveMs - a.inclusiveMs);
  return { totalMs: total / 1000, functions: rows.slice(0, top) };
}

export function formatProfile(title: string, summary: ReturnType<typeof summarizeProfile>, top = 30): string {
  const lines = [`CPU profile — ${title} (${summary.totalMs.toFixed(0)} ms of JS/native samples)`, ''];
  lines.push(`${'inclusive'.padStart(10)}${'self'.padStart(9)}  function`);
  for (const row of summary.functions.slice(0, top)) {
    lines.push(`${row.inclusiveMs.toFixed(1).padStart(10)}${row.selfMs.toFixed(1).padStart(9)}  ${row.name}  ${row.where}`);
  }
  return lines.join('\n');
}

export function saveProfile(dir: string, name: string, profile: CpuProfile): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.cpuprofile`);
  writeFileSync(path, JSON.stringify(profile));
  return path;
}
