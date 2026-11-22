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
  typeOnly: boolean;
}

const FILES = sourceFiles(SRC);
const KNOWN = new Set(FILES.map(named));

function target(file: string, specifier: string): string | undefined {
  const base = named(resolve(dirname(file), specifier));
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => KNOWN.has(candidate));
}

/** Source with its comments removed, so an import named in prose isn't read as one. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

const IMPORTS: Import[] = FILES.flatMap((file) => {
  const found: Import[] = [];
  const text = code(file);
  const add = (specifier: string, typeOnly: boolean) => {
    if (specifier.startsWith('.')) {
      const to = target(file, specifier);
      if (to) found.push({ from: named(file), to, relative: true, typeOnly });
    } else {
      found.push({ from: named(file), to: specifier, relative: false, typeOnly });
    }
  };
  for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;'"]*?from\s+['"]([^'"]+)['"]/g)) add(match[2]!, Boolean(match[1]));
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) add(match[1]!, false);
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(match[1]!, false);
  return found;
});

/** Every relative import out of `layer`, as `file -> file`, that `allowed` doesn't accept. */
function strays(layer: string, allowed: (to: string) => boolean): string[] {
  return IMPORTS.filter((entry) => entry.relative && layerOf(entry.from) === layer && layerOf(entry.to) !== layer && !allowed(entry.to))
    .map((entry) => `${entry.from} -> ${entry.to}`)
    .sort();
}

const within = (...layers: string[]) => (to: string) => layers.includes(layerOf(to));

describe('the dependency rules are kept', () => {
  it('finds the source and its imports', () => {
    expect(FILES.length).toBeGreaterThan(400);
    expect(IMPORTS.filter((entry) => entry.relative).length).toBeGreaterThan(3000);
    expect(existsSync(join(SRC, 'document', 'types.ts'))).toBe(true);
  });

  // "`depth/`, `gallery/` and `traffic/` import only `document/`; `layout/` also imports
  // `edges/bundles`. `collab/` imports `document/`, `depth/` and `lib/`. `history/` imports
  // `document/` and `depth/`, plus `collab/selective`'s `changeKeys`. `continuation/` also imports
  // `render/text` and `edges/` routing helpers; `openPoints/` also imports `depth/` and `render/`."
  it.each([
    ['document', within('lib')],
    ['depth', within('document')],
    ['gallery', within('document')],
    ['traffic', within('document')],
    ['ink', within('document')],
    ['layout', (to: string) => layerOf(to) === 'document' || to === 'src/edges/bundles.ts'],
    ['collab', within('document', 'depth', 'lib')],
    ['history', (to: string) => within('document', 'depth')(to) || to === 'src/collab/selective.ts'],
    ['continuation', within('document', 'render', 'edges')],
    ['openPoints', within('document', 'depth', 'render')],
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
  it.each(['document', 'collab', 'ink', 'agent', 'depth', 'traffic', 'gallery', 'history', 'layout', 'sequence'])(
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
    if (!entry.relative || entry.typeOnly) continue;
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
