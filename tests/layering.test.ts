import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The dependency rules in AGENTS.md ("Architecture", "Model and module boundaries"), as a test.
 *
 * They were kept by review alone, and one had slipped: the sequence builder imported a pure helper
 * from the presentation hook's module, so exporting a sequence loaded React, React Flow and both
 * editor stores. A rule written here fails the day it is broken instead.
 *
 * A layer is a directory directly under `src/`. Type-only imports count too: a type from the store
 * in the document model is the first step of the same coupling.
 */
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** `src/edges/routing.ts`, with forward slashes on every platform. */
const named = (file: string): string => relative(ROOT, file).split('\\').join('/');
/** The layer a file belongs to: its directory under `src/`, or `(root)` for `src/App.tsx` and its like. */
const layerOf = (name: string): string => {
  const parts = name.split('/');
  return parts.length === 2 ? '(root)' : parts[1]!;
};

interface Import {
  /** The importing file. */
  from: string;
  /** What it names: a file in `src/` for a relative import, the package name otherwise. */
  to: string;
  relative: boolean;
  /**
   * `static`: an `import`/`export … from` that runs when the module loads. `type`: erased by the
   * compiler (`import type`, `export type … from`, `typeof import(…)`). `dynamic`: an
   * `import(…)` call, a seam that loads later. Every kind counts for the layer rules; only `static`
   * can close a ring.
   */
  kind: 'static' | 'type' | 'dynamic';
}

const FILES = sourceFiles(SRC);
const KNOWN = new Set(FILES.map(named));

/** The file a relative specifier names, as the compiler resolves it: `./x.js` is `./x.ts` here. */
function target(file: string, specifier: string): string | undefined {
  const base = named(resolve(dirname(file), specifier.replace(/\?.*$/, '')));
  const bare = base.replace(/\.(js|jsx|mjs)$/, '');
  return [base, `${bare}.ts`, `${bare}.tsx`, `${bare}/index.ts`, `${bare}/index.tsx`].find((candidate) => KNOWN.has(candidate));
}

/** Source with its comments removed, so an import named in prose isn't read as one. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Whether the compiler erases the whole statement: `import type …` and `export type … from` only.
 * Not `import { type A, type B } from './m'`: under `verbatimModuleSyntax`, which every project
 * here sets, the names go and `import {} from './m'` stays, so the module is still loaded.
 */
function erased(clause: string): boolean {
  return /^type\b/.test(clause.trim());
}

/**
 * A file's imports, read by pattern: this project's compiler ships no parser a test can call. What
 * the patterns are relied on for is narrow, and "the scanner" tests below hold each case: a statement's
 * specifier, whether the whole statement is erased, and an `import(…)` call apart from a `typeof import(…)`
 * type. An `import('x').T` written as a type without `typeof` reads as `dynamic`; either way it
 * counts for the layer rules and cannot close a ring.
 */
function importsIn(from: string, text: string, resolveTo: (specifier: string) => string | undefined): Import[] {
  const found: Import[] = [];
  const add = (specifier: string, kind: Import['kind']) => {
    if (!specifier.startsWith('.')) found.push({ from, to: specifier, relative: false, kind });
    else {
      const to = resolveTo(specifier);
      if (to) found.push({ from, to, relative: true, kind });
    }
  };
  for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+([^;'"]*?)\s*from\s+['"]([^'"]+)['"]/g)) add(match[2]!, erased(match[1]!) ? 'type' : 'static');
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) add(match[1]!, 'static');
  for (const match of text.matchAll(/(\btypeof\s+)?\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(match[2]!, match[1] ? 'type' : 'dynamic');
  return found;
}

const IMPORTS: Import[] = FILES.flatMap((file) => importsIn(named(file), code(file), (specifier) => target(file, specifier)));

/** Every relative import out of `layer`, as `file -> file`, that `allowed` doesn't accept. */
function strays(layer: string, allowed: (to: string) => boolean): string[] {
  return IMPORTS.filter((entry) => entry.relative && layerOf(entry.from) === layer && layerOf(entry.to) !== layer && !allowed(entry.to))
    .map((entry) => `${entry.from} -> ${entry.to}`)
    .sort();
}

const within = (...layers: string[]) => (to: string) => layers.includes(layerOf(to));

/** The files outside `document/` and `depth/` that `evolution/` may read, each pure and worker-safe. */
const EVOLUTION_FROM_ELSEWHERE = [
  'src/export/project.ts',
  'src/export/canonical.ts',
  'src/collab/changes.ts',
  'src/collab/diff.ts',
  'src/collab/equal.ts',
  'src/collab/fileIndex.ts',
  'src/collab/apply.ts',
  'src/collab/repair.ts',
];

describe('the dependency rules are kept', () => {
  it('finds the source and its imports', () => {
    expect(FILES.length).toBeGreaterThan(400);
    expect(IMPORTS.filter((entry) => entry.relative).length).toBeGreaterThan(3000);
    expect(existsSync(join(SRC, 'document', 'types.ts'))).toBe(true);
  });

  // The rules above are only as good as what the scanner sees.
  describe('the scanner', () => {
    const scan = (text: string) => importsIn('src/a/file.ts', text, (specifier) => `resolved:${specifier}`).map((entry) => `${entry.kind} ${entry.to}`);

    it('tells an import that runs from one the compiler erases', () => {
      expect(scan("import { a } from './a';\nimport b, { type B } from './b';\nexport * from './c';\nimport './side-effect';")).toEqual([
        'static resolved:./a',
        'static resolved:./b',
        'static resolved:./c',
        'static resolved:./side-effect',
      ]);
      expect(scan("import type { A } from './a';\nexport type { D } from './d';\nimport type E from './e';")).toEqual([
        'type resolved:./a',
        'type resolved:./d',
        'type resolved:./e',
      ]);
    });

    it('counts a clause of only inline `type` names as loading the module, which it does', () => {
      // `verbatimModuleSyntax` leaves `import {} from './b'` behind: the module still runs.
      expect(scan("import { type B, type C } from './b';\nexport { type E } from './e';")).toEqual(['static resolved:./b', 'static resolved:./e']);
    });

    it('reads a clause spread over several lines', () => {
      expect(scan("import {\n  a,\n  type B,\n} from './a';\nimport type {\n  C,\n  D,\n} from './b';")).toEqual(['static resolved:./a', 'type resolved:./b']);
    });

    it('keeps a later-loading import() and a typeof import() type out of the static imports', () => {
      expect(scan("const later = () => import('./worker');\nlet module: typeof import('./types');\nconst pkg = await import('react');")).toEqual([
        'dynamic resolved:./worker',
        'type resolved:./types',
        'dynamic react',
      ]);
    });

    it('resolves a .js specifier to the TypeScript file it names', () => {
      expect(target(join(SRC, 'edges', 'describe.ts'), './routing.js')).toBe('src/edges/routing.ts');
      expect(target(join(SRC, 'edges', 'describe.ts'), './routing')).toBe('src/edges/routing.ts');
      expect(target(join(SRC, 'edges', 'describe.ts'), '../document/types.js')).toBe('src/document/types.ts');
      expect(target(join(SRC, 'edges', 'describe.ts'), './no-such-module')).toBeUndefined();
    });
  });

  // "`depth/`, `gallery/` and `traffic/` import only `document/`; `layout/` also imports
  // `edges/bundles`. `collab/` imports `document/`, `depth/` and `lib/`. `history/` imports
  // `document/` and `depth/`, plus `collab/selective`'s `changeKeys`. `continuation/` also imports
  // `render/text` and `edges/` routing helpers; `openPoints/` also imports `depth/` and `render/`."
  it.each([
    ['document', within('lib')],
    ['depth', within('document')],
    ['gallery', within('document')],
    // The loop finder is shared with the architecture model (`model/scc.ts`), the one implementation.
    ['traffic', within('document', 'model')],
    // The architecture read out of the file: derived from the model and the room tree, nothing else.
    ['model', within('document', 'depth')],
    // Checks read the file, the model and how work travels, and reach a repository only through
    // the reader they are handed (`checks/evidence/reader.ts`).
    ['checks', within('document', 'depth', 'model', 'traffic')],
    ['ink', within('document')],
    // Linked Junctions read the file, room by room, and nothing of the editor.
    ['junctions', within('document', 'depth')],
    ['layout', (to: string) => layerOf(to) === 'document' || to === 'src/edges/bundles.ts'],
    ['collab', within('document', 'depth', 'lib')],
    ['history', (to: string) => within('document', 'depth')(to) || to === 'src/collab/selective.ts'],
    ['continuation', within('document', 'render', 'edges')],
    ['openPoints', within('document', 'depth', 'render')],
    // Canvas Evolution's domain runs in the history worker: the model, the room tree, the canonical
    // serializer, and only the pure comparison helpers of collaboration — never collab's sessions,
    // transport or sanitizer, and never `lib/` wholesale.
    ['evolution', (to: string) => within('document', 'depth')(to) || EVOLUTION_FROM_ELSEWHERE.includes(to)],
  ] as const)('%s/ imports only what it is allowed to', (layer, allowed) => {
    expect(strays(layer, allowed)).toEqual([]);
  });

  // The model, the geometry and the renderers are what the canvas, the export, the agent's worker
  // and the tests all share. None of them may reach up into the editor.
  const EDITOR = ['ui', 'canvas', 'store', 'commands', 'desktop', 'presentation', 'host', '(root)'];
  it.each(['document', 'edges', 'nodes', 'render', 'layout', 'sequence', 'export', 'import', 'crypto', 'theme'])(
    '%s/ never reaches the editor',
    (layer) => {
      // `sequence/` reads `presentation/steps.ts`: how a flow's steps are numbered, document in and out.
      const allowed = (to: string) => !EDITOR.includes(layerOf(to)) || (layer === 'sequence' && to === 'src/presentation/steps.ts');
      expect(strays(layer, allowed)).toEqual([]);
    },
  );

  // The history worker loads `evolution/` alone: nothing of the editor may come with it.
  // The headless CLI and the agent worker load these with no editor around them.
  it.each(['model', 'checks'])('%s/ never reaches the editor', (layer) => {
    expect(strays(layer, (to) => !EDITOR.includes(layerOf(to)))).toEqual([]);
  });

  it('evolution/ never reaches the editor', () => {
    expect(strays('evolution', (to) => !EDITOR.includes(layerOf(to)))).toEqual([]);
  });

  // "`agent/` may consume these and rendering/export helpers, never UI or store modules."
  it('agent/ never imports UI, canvas, store or shell modules', () => {
    expect(strays('agent', (to) => !EDITOR.includes(layerOf(to)))).toEqual([]);
  });

  // "`canvas/`, `commands/` and `store/` import no `ui/` modules except the shared primitives in
  // `ui/common/` and the presence hooks in `ui/collab/`."
  it.each(['canvas', 'commands', 'store'])('%s/ takes only shared primitives from ui/', (layer) => {
    const allowed = (to: string) => layerOf(to) !== 'ui' || to.startsWith('src/ui/common/') || to.startsWith('src/ui/collab/');
    expect(strays(layer, allowed)).toEqual([]);
  });

  it('uiStore depends on no other store', () => {
    const reached = IMPORTS.filter((entry) => entry.from === 'src/store/uiStore.ts' && entry.relative && layerOf(entry.to) === 'store');
    expect(reached.map((entry) => entry.to)).toEqual([]);
  });

  // "`src/document/` imports neither React nor React Flow." The same holds for the other layers that
  // are React-free by rule (`collab/`, `ink/`, `agent/`) or by what they are. `edges/` is not
  // listed: `routing.ts` builds its paths with React Flow's own path functions.
  it.each(['document', 'collab', 'ink', 'agent', 'depth', 'traffic', 'gallery', 'history', 'layout', 'sequence', 'junctions', 'evolution', 'model', 'checks'])(
    '%s/ imports neither React, React Flow nor the store library',
    (layer) => {
      const packages = IMPORTS.filter((entry) => !entry.relative && layerOf(entry.from) === layer && /^(react|react-dom|@xyflow\/|zustand)/.test(entry.to));
      expect(packages.map((entry) => `${entry.from} -> ${entry.to}`)).toEqual([]);
    },
  );
});

/**
 * Files that import each other in a ring, found as strongly connected components of the value-import
 * graph (a type-only import is erased, and a dynamic `import()` is a seam, not a ring).
 */
function cycles(): string[][] {
  const edges = new Map<string, string[]>();
  for (const entry of IMPORTS) {
    if (!entry.relative || entry.kind !== 'static') continue;
    edges.set(entry.from, [...(edges.get(entry.from) ?? []), entry.to]);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  let next = 0;
  const visit = (node: string): void => {
    index.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);
    for (const to of edges.get(node) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(node, Math.min(low.get(node)!, index.get(to)!));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const ring: string[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      ring.push(member);
      if (member === node) break;
    }
    if (ring.length > 1) found.push(ring.sort());
  };
  for (const file of KNOWN) if (!index.has(file)) visit(file);
  return found;
}

/**
 * The rings that existed when this test was written. Each may lose members or disappear (delete it
 * here when it does); none may grow, and no new one may appear.
 */
const KNOWN_CYCLES: string[][] = [
  // Arrange, place and compile call each other by design: a layout is compiled, placed and judged in turns.
  ['arrange', 'compile', 'input', 'place', 'placeExplicit', 'proportion', 'quality', 'starter'].map((name) => `src/agent/${name}.ts`),
  ['src/commands/depthNavigation.ts', 'src/commands/search.ts'],
];

describe('import cycles', () => {
  it('has none beyond the known ones, and those only shrink', () => {
    const unexpected = cycles().filter((ring) => !KNOWN_CYCLES.some((known) => ring.every((file) => known.includes(file))));
    expect(unexpected).toEqual([]);
  });

  it('lists no cycle that has since been broken', () => {
    const live = cycles();
    const stale = KNOWN_CYCLES.filter((known) => !live.some((ring) => ring.every((file) => known.includes(file))));
    expect(stale).toEqual([]);
  });
});
