import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkResult } from '../types';

/** Always overwritten — one stable "latest" file, no per-run history. */
export function writeJsonReport(result: BenchmarkResult, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'latest.json');
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  return outPath;
}
