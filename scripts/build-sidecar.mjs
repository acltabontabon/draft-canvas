#!/usr/bin/env node
/**
 * Builds the MCP sidecar (`src-tauri/mcp`, binary `draft-canvas-mcp`) and copies it to
 * `src-tauri/binaries/draft-canvas-mcp-<target triple>[.exe]`, the name Tauri's `externalBin` bundles
 * (it strips the triple as it copies the binary beside the app's own executable).
 *
 * The triple is Tauri's when a Tauri build runs this (`TAURI_ENV_TARGET_TRIPLE`, so a cross-build of
 * the x64 macOS app gets an x64 sidecar), otherwise the host's. `--release` (or a non-debug Tauri
 * build) builds optimised.
 *
 *   node scripts/build-sidecar.mjs [--release]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(root, 'src-tauri');

const hostTriple = () => {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('host:'));
  if (!line) throw new Error('rustc -vV did not name a host triple');
  return line.slice('host:'.length).trim();
};

const explicit = process.env.TAURI_ENV_TARGET_TRIPLE;
const triple = explicit || hostTriple();
const release = process.argv.includes('--release') || (process.env.TAURI_ENV_DEBUG !== undefined && process.env.TAURI_ENV_DEBUG !== 'true');

const args = ['build', '--manifest-path', join(tauriDir, 'Cargo.toml'), '-p', 'draft-canvas-mcp'];
if (release) args.push('--release');
if (explicit) args.push('--target', triple);
execFileSync('cargo', args, { stdio: 'inherit' });

const exe = triple.includes('windows') ? '.exe' : '';
const profile = release ? 'release' : 'debug';
const built = explicit ? join(tauriDir, 'target', triple, profile, `draft-canvas-mcp${exe}`) : join(tauriDir, 'target', profile, `draft-canvas-mcp${exe}`);
const target = join(tauriDir, 'binaries', `draft-canvas-mcp-${triple}${exe}`);
mkdirSync(dirname(target), { recursive: true });
copyFileSync(built, target);
if (!exe) chmodSync(target, 0o755);
console.log(`draft-canvas-mcp → ${target}`);
