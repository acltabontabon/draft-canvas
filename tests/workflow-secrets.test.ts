import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = resolve(__dirname, '../.github/workflows');
const files = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));

describe('workflow secrets', () => {
  it('finds the workflows', () => {
    expect(files).toEqual(expect.arrayContaining(['release.yml', 'pages.yml', 'pages-site.yml']));
  });

  // `secrets: inherit` handed a called workflow, and the third-party packages it builds with, every
  // repository secret: the web deploy was given the update signing key and the Homebrew tap key.
  it('are passed to a called workflow by name, never inherited whole', () => {
    for (const file of files) {
      expect(readFileSync(join(WORKFLOWS, file), 'utf8'), file).not.toMatch(/^\s*secrets:\s*inherit\b/m);
    }
  });
});
