import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The documentation's links, checked rather than trusted.
 *
 * Docs move (they did, once, from ALL_CAPS files to `docs/guides` and `docs/reference`), and a
 * moved file leaves every link to it quietly pointing nowhere. This walks the Markdown that GitHub
 * renders and fails on a relative link whose file is gone or whose `#anchor` no longer matches a
 * heading. External URLs are not fetched: the app makes no network calls and neither does its
 * test suite.
 */

const ROOT = join(import.meta.dirname, '..');

/** Markdown a reader can land on. Dependencies and build output are not docs. */
function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // Dot-directories are tooling (`.git`, `.vscode-test` holds a downloaded copy of VS Code) —
    // except `.github`, whose issue and PR templates are Markdown a reader lands on.
    if (['node_modules', 'dist', 'test-results', 'playwright-report'].includes(entry)) continue;
    if (entry.startsWith('.') && entry !== '.github') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (entry.endsWith('.md')) out.push(path);
  }
  return out;
}

/** The text of a Markdown file with fenced code removed — a `[x](y)` in an example is not a link. */
function prose(file: string): string {
  return readFileSync(file, 'utf8').replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
}

/** GitHub's heading-to-anchor rule: lowercase, drop punctuation, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

function anchorsOf(file: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const [, heading] of prose(file).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(heading!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  // Explicit anchors, for the few places that need one.
  for (const [, id] of readFileSync(file, 'utf8').matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(id!);
  return anchors;
}

const FILES = markdownFiles(ROOT);

describe('documentation links', () => {
  it('finds the docs', () => {
    expect(FILES.map((f) => relative(ROOT, f))).toEqual(expect.arrayContaining(['README.md', 'docs/index.md']));
  });

  it('every relative link resolves to a file, and every #anchor to a heading', () => {
    const broken: string[] = [];
    for (const file of FILES) {
      // `[text](target)` — a target may not contain spaces or a closing parenthesis.
      for (const [, target] of prose(file).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target!)) continue; // https:, mailto:, …
        const [pathPart, anchor] = target!.split('#') as [string, string | undefined];
        const dest = pathPart === '' ? file : resolve(dirname(file), pathPart);
        if (!existsSync(dest)) {
          broken.push(`${relative(ROOT, file)} → ${target} (no such file)`);
        } else if (anchor && dest.endsWith('.md') && !anchorsOf(dest).has(anchor)) {
          broken.push(`${relative(ROOT, file)} → ${target} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('keeps docs filenames lowercase kebab-case', () => {
    const offenders = FILES.map((f) => relative(ROOT, f)).filter(
      (f) => f.startsWith(`docs${'/'}`) && !/^docs\/([a-z0-9-]+\/)*[a-z0-9-]+\.md$/.test(f),
    );
    expect(offenders).toEqual([]);
  });
});
