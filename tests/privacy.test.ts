import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The privacy promise, enforced rather than asserted.
 *
 * Draft Canvas claims that nothing you draw leaves your machine. That claim is
 * only worth anything if it is mechanically checked, so this walks the entire
 * source tree looking for any way a byte could reach the network. If someone
 * adds a `fetch` in a year's time, this test is what tells them.
 */

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Every way a browser can talk to a server. */
const NETWORK_APIS: [string, RegExp][] = [
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bnew\s+WebSocket\b/],
  ['EventSource', /\bnew\s+EventSource\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['importScripts', /\bimportScripts\s*\(/],
  ['dynamic remote import', /\bimport\s*\(\s*['"`]https?:/],
];

/** Ways code could be built from a string at runtime. */
const EVAL_APIS: [string, RegExp][] = [
  ['eval', /\beval\s*\(/],
  ['Function constructor', /\bnew\s+Function\s*\(/],
  ['setTimeout with a string', /setTimeout\s*\(\s*['"`]/],
];

describe('nothing on the canvas can reach a network', () => {
  const files = sourceFiles(SRC);

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(NETWORK_APIS)('uses no %s anywhere in src/', (_name, pattern) => {
    const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it.each(EVAL_APIS)('never evaluates code from a string (%s)', (_name, pattern) => {
    const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('declares no remote origin in the built HTML', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    // The favicon is an inline data URI; nothing else may point outward.
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:/);
  });

  it('pulls in no analytics or telemetry package', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).toEqual(
      expect.arrayContaining(['@xyflow/react', 'idb', 'react', 'react-dom', 'refractor', 'zustand']),
    );
    // A short, auditable dependency list is part of the promise.
    expect(deps).toHaveLength(6);
    for (const name of deps) {
      expect(name).not.toMatch(/analytics|telemetry|sentry|tracking|posthog|mixpanel|segment/i);
    }
  });
});

describe('localStorage holds preferences only', () => {
  const files = sourceFiles(SRC);

  // Matches real access (`localStorage.getItem`, `localStorage[key]`) rather
  // than the word, so prose about storage in a comment is not a false alarm.
  const WEB_STORAGE = /\b(?:local|session)Storage\s*[.[]/;

  it('is accessed from exactly one module', () => {
    const users = files.filter(
      (file) => WEB_STORAGE.test(readFileSync(file, 'utf8')) && !file.endsWith('preferences.ts'),
    );
    // Funnelling access through one module is what makes the claim checkable.
    expect(users.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('stores no canvas content, only short named preferences', () => {
    const source = readFileSync(join(SRC, 'lib/preferences.ts'), 'utf8');
    // Every key is namespaced and passed in by the caller; nothing serializes
    // a document here.
    expect(source).not.toMatch(/JSON\.stringify/);
    expect(source).toContain("const PREFIX = 'draft-canvas.'");
  });

  it('caps what a preference may contain', () => {
    const source = readFileSync(join(SRC, 'lib/preferences.ts'), 'utf8');
    expect(source).toMatch(/MAX_LENGTH\s*=\s*\d+/);
    expect(source).toContain('setItem');
  });
});
