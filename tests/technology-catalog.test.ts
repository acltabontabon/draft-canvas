import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import * as upstream from 'simple-icons';
import { createDocument, createNode } from '../src/document/factory';
import { renderSvgText } from '../src/export/image';
import { describeContext, describeNode } from '../src/nodes/describe';
import { LIGHT } from '../src/render/theme/tokens';
import { TECHNOLOGY_PATH_LOADERS } from '../src/nodes/technologyCatalog/loaders';
import { GENERIC_TECHNOLOGY_ICON, TECHNOLOGY_ICON_COUNT, loadTechnologyIcon, subscribeTechnologyIcon, technologyIcon, technologySuggestions } from '../src/nodes/technology';

describe('complete local technology catalog', () => {
  it('tracks every name and slug in the pinned package, including names ending in digits', () => {
    expect(TECHNOLOGY_ICON_COUNT).toBe(Object.keys(upstream).length);
    const titles = Object.groupBy(Object.values(upstream), (icon) => icon.title.toLowerCase());
    for (const icon of Object.values(upstream)) {
      const name = titles[icon.title.toLowerCase()]!.length > 1 ? `${icon.title} (${icon.slug})` : icon.title;
      expect(technologyIcon(name)?.slug, name).toBe(icon.slug);
      expect(technologyIcon(icon.slug)?.slug, icon.slug).toBe(icon.slug);
    }
    expect(technologySuggestions('PlayStation 5')[0]!.value).toBe('PlayStation 5');
    expect(technologySuggestions('vuejs')[0]?.icon.slug).toBe('vuedotjs');
    const backstage = technologySuggestions('backstage');
    expect(backstage.map((entry) => entry.value)).toEqual(['Backstage (backstage)', 'Backstage (backstage_casting)']);
    for (const suggestion of backstage) expect(technologyIcon(suggestion.value)?.slug).toBe(suggestion.icon.slug);
  });

  it('keeps generated metadata, paths and source/license notices in sync with the dependency', () => {
    execFileSync(process.execPath, ['scripts/technology-catalog.mjs', '--check'], { cwd: import.meta.dirname + '/..', stdio: 'pipe' });
  });

  it('loads only the requested group, deduplicates requests, and notifies only matching subscribers', async () => {
    const a = vi.spyOn(TECHNOLOGY_PATH_LOADERS, 'a');
    const r = vi.spyOn(TECHNOLOGY_PATH_LOADERS, 'r');
    const notify = vi.fn();
    const other = vi.fn();
    const stop = subscribeTechnologyIcon('Apache Cassandra', notify);
    const stopOther = subscribeTechnologyIcon('Rust', other);
    expect(technologyIcon('Apache Cassandra')!.path).toBe(GENERIC_TECHNOLOGY_ICON.path);
    const [one, two] = await Promise.all([loadTechnologyIcon('Apache Cassandra'), loadTechnologyIcon('apachecassandra 5')]);
    expect(one!.path).toBe(upstream.siApachecassandra.path);
    expect(two).toBe(one);
    expect(a).toHaveBeenCalledTimes(1);
    expect(r).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    await loadTechnologyIcon('Apache Cassandra');
    await loadTechnologyIcon('Private runtime / Rust');
    expect(a).toHaveBeenCalledTimes(1);
    stop(); stopOther(); vi.restoreAllMocks();
  });

  it('allows a failed asset load to be retried without relabelling the saved technology', async () => {
    const loader = vi.spyOn(TECHNOLOGY_PATH_LOADERS, 'v');
    loader.mockRejectedValueOnce(new Error('Temporary asset failure'));
    await expect(loadTechnologyIcon('Vue.js')).rejects.toThrow('Temporary asset failure');
    expect(technologyIcon('Vue.js')!.slug).toBe('vuedotjs');
    const icon = await loadTechnologyIcon('Vue.js');
    expect(icon!.path).toBe(upstream.siVuedotjs.path);
    expect(loader).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('keeps an existing render context deterministic while fresh contexts see newly loaded artwork', async () => {
    const node = createNode({ type: 'service', x: 0, y: 0, technology: 'Kotlin' });
    const context = describeContext(LIGHT);
    const before = describeNode(node, context);
    await loadTechnologyIcon('Kotlin');
    expect(describeNode(node, context)).toEqual(before);
    expect(describeNode(node, describeContext(LIGHT)).shapes.at(-1)).toMatchObject({
      t: 'group', children: [{ t: 'path', d: upstream.siKotlin.path }],
    });
  });

  it('loads a cold logo before exporting, embedding its path rather than a placeholder or URL', async () => {
    const node = createNode({ type: 'service', x: 0, y: 0, technology: 'Zig 0.15' });
    expect(technologyIcon(node.technology)!.path).toBe(GENERIC_TECHNOLOGY_ICON.path);
    const svg = await renderSvgText({ ...createDocument('Zig'), nodes: [node] }, { includeBackground: false });
    expect(svg).toContain(upstream.siZig.path);
    expect(svg).toContain('<title>Zig 0.15</title>');
    expect(svg).not.toContain(GENERIC_TECHNOLOGY_ICON.path);
    expect(svg).not.toMatch(/<image|(?:href|src)="https?:/);
  });

  it('imports every artwork group and preserves all upstream paths, including numeric slugs', async () => {
    const groups = await Promise.all(Object.values(TECHNOLOGY_PATH_LOADERS).map((load) => load()));
    const paths = Object.assign({}, ...groups.map((group) => group.default)) as Record<string, string>;
    expect(Object.keys(paths)).toHaveLength(TECHNOLOGY_ICON_COUNT);
    for (const icon of Object.values(upstream)) expect(paths[icon.slug], icon.slug).toBe(icon.path);
  });
});
