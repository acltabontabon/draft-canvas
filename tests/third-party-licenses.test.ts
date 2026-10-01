import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THIRD_PARTY_LICENSES.txt is generated (`npm run licenses`) and committed, so the build can ship it
 * without a package manager at hand. A dependency added or bumped without regenerating it would ship
 * a notices file that misses an author — this fails the moment package.json and the file disagree.
 * The desktop CI, which has cargo, runs the full `npm run licenses:check`; here, the npm side.
 */
const ROOT = resolve(__dirname, '..');
const text = readFileSync(resolve(ROOT, 'THIRD_PARTY_LICENSES.txt'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; dev?: boolean }>;
};

describe('THIRD_PARTY_LICENSES.txt', () => {
  it('names every production dependency at the version the lockfile pins', () => {
    for (const name of Object.keys(pkg.dependencies)) {
      const version = lock.packages[`node_modules/${name}`]?.version;
      expect(version, name).toBeDefined();
      expect(text, `${name}@${version}`).toContain(`### ${name} ${version} — `);
    }
  });

  it('names the production closure, not the development tools', () => {
    for (const name of ['vitest', 'oxlint', 'typescript', '@playwright/test']) {
      expect(text).not.toMatch(new RegExp(`^### ${name.replace(/[/@]/g, '\\$&')} `, 'm'));
    }
    const shipped = Object.entries(lock.packages).filter(([path, entry]) => path.startsWith('node_modules/') && !entry.dev && entry.version);
    expect(shipped.length).toBeGreaterThan(5);
    for (const [path, entry] of shipped) {
      const name = path.slice('node_modules/'.length).split('/node_modules/').at(-1)!;
      expect(text, `${name}@${entry.version}`).toContain(`### ${name} ${entry.version} — `);
    }
  });

  it('carries licence text, not only names', () => {
    expect(text).toMatch(/MIT License/);
    expect(text).toMatch(/^## Rust crates/m);
    expect(text).not.toContain('cargo was not available');
  });
});
