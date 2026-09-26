import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The landing page in `www/` ships to the same origin as the editor, and to nothing else at all.
 *
 * It is a separate Vite project on purpose — its own package.json, its own lockfile, no dependency
 * in common with the app — because the alternative is a marketing stylesheet that one day turns up
 * in the editor, a `fetch` in the app's source that only exists to power a download button, or a
 * copy of the product's tokens that quietly stops matching the product. Keeping them apart is only
 * worth anything if it is mechanically checked, which is what this is.
 *
 * What it does *not* cover, because a static read cannot: that the assembled artifact keeps the two
 * bundles apart at the paths they are served from. `e2e/web-deploy.spec.ts` does that against the
 * real build.
 */

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const WWW = join(ROOT, 'www');

function filesUnder(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return filesUnder(full, extensions);
    return extensions.some((extension) => entry.endsWith(extension)) ? [full] : [];
  });
}

describe('the landing page and the app stay apart', () => {
  it('the site imports nothing from the app', () => {
    const offenders = filesUnder(WWW, ['.js', '.mjs', '.html', '.css']).filter((file) => {
      // `www/scripts/` is build tooling: it is allowed to *run* the repo's harnesses and read the
      // repo's media. What must not happen is the shipped page importing app code.
      if (relative(WWW, file).startsWith('scripts')) return false;
      return /(?:from|import|src=|href=)\s*['"][^'"]*\.\.\/(?:\.\.\/)*src\//.test(readFileSync(file, 'utf8'));
    });
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('the app imports nothing from the site', () => {
    const offenders = filesUnder(SRC, ['.ts', '.tsx', '.css']).filter((file) =>
      /['"][^'"]*\bwww\//.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('shares no dependency with the app, so neither can drag the other along', () => {
    const site = JSON.parse(readFileSync(join(WWW, 'package.json'), 'utf8'));
    expect(site.dependencies ?? {}).toEqual({});
    // Vite only, and only to build with. Anything else here would be a runtime dependency the page
    // does not need and the app did not choose.
    expect(Object.keys(site.devDependencies ?? {})).toEqual(['vite']);
  });

  it('makes no network request of its own', () => {
    // The same promise the app makes, for the same reason — and the page's own CSP says
    // `connect-src 'none'`, so the browser would refuse anyway.
    const shipped = filesUnder(join(WWW, 'src'), ['.js']).concat(
      existsSync(join(WWW, 'index.html')) ? [join(WWW, 'index.html')] : [],
    );
    for (const file of shipped) {
      const source = readFileSync(file, 'utf8');
      for (const api of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /sendBeacon/]) {
        expect(api.test(source), `${relative(ROOT, file)} uses ${api}`).toBe(false);
      }
    }
    expect(readFileSync(join(WWW, 'vite.config.js'), 'utf8')).toContain("connect-src 'none'");
  });

  it('leaves the editor build alone', () => {
    // The editor is deployed by copying `dist/` in unchanged. Anything that made the app's build
    // aware of the site would end up in the Docker image and the desktop installer too.
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).not.toMatch(/\bwww\b/);
    expect(config).toContain("base: './'");

    const editorHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(editorHtml).not.toMatch(/www\//);
    expect(editorHtml).not.toMatch(/styles\.css/);
  });

  it('keeps the desktop entry point pointed at bundled files, not the page', () => {
    const tauri = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
    // Bundled files, never a URL: the desktop app must open with no network at all.
    expect(tauri.build.frontendDist).toBe('../dist-desktop');
  });
});
