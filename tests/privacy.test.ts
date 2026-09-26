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
    // What this is guarding is a *fetched subresource*: a script, a stylesheet, a font, an image
    // the browser goes and gets while loading the app. The favicon is an inline data URI, and
    // nothing else may point outward.
    //
    // `rel="canonical"` is exempt, and only that. It is metadata for a crawler — the browser never
    // requests it — in the same category as the og:image URL two lines below it, which has always
    // been allowed because it sits in a `content` attribute rather than an `href`. It exists
    // because the app is served one level under the landing page and should not be indexed as a
    // second copy of it.
    const fetched = html.replace(/<link\s[^>]*rel=["']canonical["'][^>]*>/g, '');
    expect(fetched).not.toMatch(/(src|href)\s*=\s*["']https?:/);
  });

  it('pulls in no analytics or telemetry package', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).toEqual(
      expect.arrayContaining([
        '@xyflow/react',
        'idb',
        'react',
        'react-dom',
        'refractor',
        'zustand',
      ]),
    );
    // A short, auditable dependency list is part of the promise.
    expect(deps).toHaveLength(6);
    for (const name of deps) {
      expect(name).not.toMatch(/analytics|telemetry|sentry|tracking|posthog|mixpanel|segment/i);
    }
  });

  // The desktop app's Tauri packages are development dependencies on purpose: they are bundled only
  // into the desktop build (`vite --mode desktop`), and never reach what the web serves.
  it('keeps the desktop shell’s packages out of the web app’s dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@tauri-apps/'))).toEqual([]);
  });
});

describe('the desktop shell is reached from one place', () => {
  // The rest of the app must not care which host it runs in: it talks to `src/desktop/api.ts`, and
  // only `src/desktop/tauri/` turns that into calls to Tauri.
  it('imports Tauri only from src/desktop/tauri/', () => {
    const tauriDir = join(SRC, 'desktop', 'tauri');
    const offenders = sourceFiles(SRC).filter(
      (file) => !file.startsWith(tauriDir) && /from\s+['"]@tauri-apps\//.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('never reaches for the Tauri globals directly', () => {
    const offenders = sourceFiles(SRC).filter((file) => /__TAURI|window\.isTauri|globalThis\.isTauri/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
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

describe('where a diagram is stored does not depend on where the app is served from', () => {
  const files = sourceFiles(SRC);

  /*
   * The editor moved from /draft-canvas/ to /draft-canvas/editor/ without anyone re-importing a
   * diagram, and that only held because no storage name is derived from the URL: the IndexedDB
   * databases and the localStorage prefix are plain constants, so they are per-origin and the path
   * is irrelevant. This is what keeps that true. A key built from `location.pathname` or
   * `import.meta.env.BASE_URL` would orphan every existing diagram the next time the app is served
   * from somewhere else — silently, and only for people who already had work saved.
   */
  const PATH_DERIVED = /(?:indexedDB\.open|DB_NAME|KEY_DB_NAME|PREFIX)[^;\n]*(?:location\.|BASE_URL)/;

  it('names no database or preference key after the URL', () => {
    const offenders = files.filter((file) => PATH_DERIVED.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('keeps the database names constant', () => {
    expect(readFileSync(join(SRC, 'storage/IndexedDbRepository.ts'), 'utf8')).toContain(
      "const DB_NAME = 'draft-canvas'",
    );
    expect(readFileSync(join(SRC, 'crypto/keyStore.ts'), 'utf8')).toContain(
      "const KEY_DB_NAME = 'draft-canvas-keys'",
    );
  });
});
