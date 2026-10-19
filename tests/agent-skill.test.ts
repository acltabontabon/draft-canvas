import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CROWDED_BOUNDARY, CROWDED_VIEW } from '../src/agent/advice';
import { CONTRACT_VERSION } from '../src/agent/capabilities';
import { ELEMENT_TYPE_NAMES, GROUP_KINDS, NOTE_FORM_NAMES, resolveType } from '../src/agent/vocabulary';
import { ACCENTS, CODE_LANGUAGES, CONNECTOR_KINDS, EDGE_SEMANTICS } from '../src/document/types';
import { skillPairingsJson } from '../scripts/agent-schemas';

/**
 * The agent skill (`skills/draft-canvas/`) is installed into agents' skill folders and read there, far
 * from this code. Its checker script and instructions restate the app's vocabulary and thresholds;
 * these tests fail when the app changes them and the skill hasn't caught up.
 */

const SKILL = join(__dirname, '..', 'skills', 'draft-canvas');
const checker = readFileSync(join(SKILL, 'scripts', 'check_diagram.py'), 'utf8');
const skillMd = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');

/** The quoted strings of one `NAME = {...}` set in the Python checker. */
function pythonSet(name: string): string[] {
  const match = new RegExp(`^${name} = \\{([^}]*)\\}`, 'ms').exec(checker);
  if (!match) throw new Error(`no ${name} set in check_diagram.py`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
}

describe('the agent skill', () => {
  it('names exactly the element types, meanings, behaviours and colours the app accepts', () => {
    expect(pythonSet('TYPES')).toEqual([...ELEMENT_TYPE_NAMES].sort());
    expect(pythonSet('SEMANTICS')).toEqual([...EDGE_SEMANTICS].sort());
    expect(pythonSet('KINDS')).toEqual([...CONNECTOR_KINDS].sort());
    expect(pythonSet('COLORS')).toEqual([...ACCENTS].sort());
    expect(pythonSet('GROUP_KINDS')).toEqual(Object.keys(GROUP_KINDS).sort());
    expect(pythonSet('NOTE_KINDS')).toEqual([...NOTE_FORM_NAMES].sort());
    expect(pythonSet('LANGUAGES')).toEqual([...CODE_LANGUAGES].sort());
  });

  it('knows the meanings each pair of element types takes, as the editor does', () => {
    // `npm run agent:schemas` rewrites the file when the capability matrix changes.
    expect(readFileSync(join(SKILL, 'scripts', 'pairings.json'), 'utf8')).toBe(skillPairingsJson());
  });

  it('accepts only aliases the app resolves', () => {
    for (const alias of pythonSet('ALIASES')) expect(resolveType(alias), alias).toBeDefined();
  });

  it('warns at the app’s own crowding thresholds', () => {
    expect(checker).toContain(`'viewElements': ${CROWDED_VIEW}`);
    expect(checker).toContain(`'boundaryMembers': ${CROWDED_BOUNDARY}`);
  });

  it('says which tool contract it was written for, and it is this one', () => {
    // Bumping CONTRACT_VERSION means re-reading the skill against the new tools, then bumping its
    // `contract` and `version` (so installed copies are replaced; see src-tauri/src/agent/skill.rs).
    expect(skillMd).toContain(`contract: "${CONTRACT_VERSION}"`);
    expect(skillMd).toContain(`written for tool contract ${CONTRACT_VERSION}`);
  });
});
