import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CROWDED_BOUNDARY, CROWDED_VIEW } from '../src/agent/advice';
import { CONTRACT_VERSION } from '../src/agent/capabilities';
import { CREATE_FIELDS, ROOM_FIELDS } from '../src/agent/fields';
import { ELEMENT_TYPE_NAMES, GROUP_KINDS, NOTE_FORM_NAMES, resolveType } from '../src/agent/vocabulary';
import { ACCENTS, CODE_LANGUAGES, CONNECTOR_KINDS, EDGE_SEMANTICS } from '../src/document/types';
import { productNamedIn } from '../src/nodes/technology';
import { skillPairingsJson } from '../scripts/agent-schemas';

/**
 * The agent skill (`skills/draft-canvas/`) is installed into agents' skill folders and read there, far
 * from this code. Its checker script and instructions restate the app's vocabulary and thresholds;
 * these tests fail when the app changes them and the skill hasn't caught up.
 */

const SKILL = join(__dirname, '..', 'skills', 'draft-canvas');
const checker = readFileSync(join(SKILL, 'scripts', 'check_diagram.py'), 'utf8');
const skillMd = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');

function python(): string | undefined {
  for (const command of ['python3', 'python']) {
    const found = spawnSync(command, ['-c', 'import sys; print(sys.version_info >= (3, 9))'], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim() === 'True') return command;
  }
  return undefined;
}
const interpreter = python();

/** Every technology `draft.py` can write: the survey's stores, brokers and providers, its frameworks
 *  and its languages, each as `product` names it. Run from the scripts folder, which `-I` leaves off
 *  the path, so it is added by hand. */
const DRAFTED_TECHNOLOGIES = `
import json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.getcwd())
import draft, scan_repo as s
names = {name for name, _, _ in s.KNOWN.values()}
names |= {name for _, name, _ in s.FRAMEWORKS if name not in draft.NOT_PRODUCTS}
names |= {language.split('/')[0] for language in s.LANGUAGES.values()}
print(json.dumps(sorted({draft.product(name) for name in names})))
`;

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

  it('allows exactly the fields a create request may carry', () => {
    // An unknown field refuses the whole request, after the checker called it ready to send.
    expect(pythonSet('REQUEST_FIELDS')).toEqual([...CREATE_FIELDS.request].sort());
    expect(pythonSet('ROOM_FIELDS')).toEqual([...ROOM_FIELDS].sort());
    expect(pythonSet('GROUP_FIELDS')).toEqual([...CREATE_FIELDS.group].sort());
    expect(pythonSet('ELEMENT_FIELDS')).toEqual([...CREATE_FIELDS.element].sort());
    expect(pythonSet('RELATIONSHIP_FIELDS')).toEqual([...CREATE_FIELDS.relationship].sort());
    expect(pythonSet('FLOW_FIELDS')).toEqual([...CREATE_FIELDS.flow].sort());
    expect(pythonSet('NOTE_FIELDS')).toEqual([...CREATE_FIELDS.note].sort());
  });

  it('knows the meanings each pair of element types takes, as the editor does', () => {
    // `npm run agent:schemas` rewrites the file when the capability matrix changes.
    expect(readFileSync(join(SKILL, 'scripts', 'pairings.json'), 'utf8')).toBe(skillPairingsJson());
  });

  it('accepts only aliases the app resolves', () => {
    for (const alias of pythonSet('ALIASES')) expect(resolveType(alias), alias).toBeDefined();
  });

  it('names only error codes the tools answer with, and every code language', () => {
    const playbook = readFileSync(join(SKILL, 'references', 'mcp-playbook.md'), 'utf8');
    const named = [...playbook.matchAll(/`([A-Z][A-Z_]{2,})`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(10);
    // The app's codes, and the ones the desktop broker answers with before a request reaches it.
    const known = new Set(
      [readFileSync(join(__dirname, '..', 'src', 'agent', 'errors.ts'), 'utf8'), readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'agent', 'broker.rs'), 'utf8')]
        .flatMap((source) => [...source.matchAll(/['"]([A-Z][A-Z_]{2,})['"]/g)].map((m) => m[1]!)),
    );
    expect(named.filter((code) => !known.has(code))).toEqual([]);
    const modeling = readFileSync(join(SKILL, 'references', 'modeling.md'), 'utf8');
    const languages = /`language` — one of ([^.]+)\./.exec(modeling)?.[1] ?? '';
    expect([...languages.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!).sort()).toEqual([...CODE_LANGUAGES].sort());
  });

  it('teaches technologies the app shows as logos', () => {
    // Agents copy the example and the vocabulary's examples, so neither may draw the advisory below.
    const technologies: string[] = [];
    const walk = (room: { nodes?: { technology?: string; inside?: object }[] }) => {
      for (const node of room.nodes ?? []) {
        if (node.technology) technologies.push(node.technology);
        if (node.inside) walk(node.inside);
      }
    };
    walk(JSON.parse(readFileSync(join(SKILL, 'references', 'example-create.json'), 'utf8')));
    const vocabulary = readFileSync(join(SKILL, 'references', 'vocabulary.md'), 'utf8');
    for (const row of vocabulary.matchAll(/^\|[^|\n]*\| `[a-z-]+`[^|\n]*\|([^|\n]*)\|$/gm)) {
      technologies.push(...[...row[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
    }
    expect(technologies.length).toBeGreaterThan(30);
    expect(technologies.filter((t) => productNamedIn(t))).toEqual([]);
  });

  it.skipIf(!interpreter)('drafts each technology as the product whose logo the app shows', () => {
    // A technology that starts with a known product but isn't one ("Anthropic API", "TypeScript,
    // Express") shows a plain mark and draws an advisory on create: an update to fix every draft.
    const run = spawnSync(interpreter!, ['-I', '-c', DRAFTED_TECHNOLOGIES], { cwd: join(SKILL, 'scripts'), encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const technologies = JSON.parse(run.stdout) as string[];
    expect(technologies.length).toBeGreaterThan(100);
    const flagged = technologies.filter((t) => productNamedIn(t));
    expect(flagged).toEqual([]);
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
