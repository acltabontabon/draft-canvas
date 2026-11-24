import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import { pasteDocument } from '../src/document/operations';
import { parseDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';
import { canvasFromStarter } from '../src/gallery/canvas';
import { clearGalleryCache } from '../src/gallery/cache';
import { matchesQuery, parseCatalog } from '../src/gallery/catalog';
import { GALLERY_BASE } from '../src/gallery/source';
import { GalleryRefreshError, loadGallery, markStarterSeen, refreshGallery, starterFile, stylePackFile } from '../src/gallery/sync';
import { vendoredCatalog, vendoredCatalogText, vendoredFile, vendoredText } from './fixtures/gallery';

/**
 * The starters gallery reads untrusted files from the network, so every step is checked: the
 * catalog is parsed strictly, each file must hash to what the catalog says and open as a diagram,
 * and a failed refresh never loses the copy already downloaded.
 */

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A GitHub that serves the vendored gallery, with `override` replacing any path's body. */
function serve(override: Record<string, string | null> = {}) {
  const catalog = JSON.parse(vendoredCatalogText()) as { starters: { path: string }[] };
  const fetch = vi.fn(async (url: string) => {
    if (!url.startsWith(GALLERY_BASE)) throw new Error(`Unexpected request to ${url}`);
    const path = url.slice(GALLERY_BASE.length);
    if (path in override) {
      const body = override[path];
      return body === null ? new Response('', { status: 404 }) : new Response(body);
    }
    if (path === 'catalog.json') return new Response(JSON.stringify(catalog));
    return new Response(vendoredText({ path }));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(async () => {
  await clearGalleryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the catalog', () => {
  it('reads the gallery’s own catalog, every starter included', () => {
    const catalog = vendoredCatalog();
    expect(catalog.starters.length).toBeGreaterThanOrEqual(14);
    expect(catalog.starters.filter((s) => s.featured)).toHaveLength(5);
    // Architectures, then data, then patterns, then examples.
    const order = catalog.starters.map((s) => s.category);
    expect(order.lastIndexOf('architecture')).toBeLessThan(order.indexOf('data'));
    expect(order.lastIndexOf('pattern')).toBeLessThan(order.indexOf('example'));
  });

  it('skips entries it can’t trust rather than the whole catalog', () => {
    const good = vendoredCatalog().starters[0]!;
    const text = JSON.stringify({
      schema: 1,
      updated: '2026-11-12',
      starters: [good, { ...good, id: 'Bad Id' }, { ...good, id: 'escape', path: '../../etc/passwd' }, { ...good, id: 'huge', bytes: 10_000_000 }, { ...good }],
    });
    const parsed = parseCatalog(text);
    expect(parsed.ok && parsed.catalog.starters.map((s) => s.id)).toEqual([good.id]);
  });

  it('asks for a newer app when the catalog is newer than it reads', () => {
    expect(parseCatalog(JSON.stringify({ schema: 2, starters: [] }))).toEqual({ ok: false, reason: 'newer' });
    expect(parseCatalog('not json')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('searches names, aliases, tags and summaries', () => {
    const cdc = vendoredCatalog().starters.find((s) => s.id === 'cdc')!;
    expect(matchesQuery(cdc, 'change data')).toBe(true);
    expect(matchesQuery(cdc, 'search index')).toBe(true);
    expect(matchesQuery(cdc, 'saga')).toBe(false);
  });
});

describe('refreshing', () => {
  it('reads the catalog and each starter from the gallery repository only', async () => {
    const fetch = serve();
    const snapshot = await refreshGallery();
    expect(snapshot.starters.every((s) => s.availability === 'ready' && s.shape)).toBe(true);
    for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(url.startsWith(GALLERY_BASE)).toBe(true);
      expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    }
    // Only what changed is read again.
    fetch.mockClear();
    await refreshGallery();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${GALLERY_BASE}catalog.json`]);
  });

  it('refuses a file that doesn’t match the catalog’s hash', async () => {
    const entry = vendoredCatalog().starters.find((s) => s.id === 'monolith')!;
    serve({ [entry.path]: vendoredText(entry).replace('Monolith', 'Tampered') });
    const snapshot = await refreshGallery();
    expect(snapshot.starters.find((s) => s.id === 'monolith')!.availability).toBe('missing');
    expect(snapshot.starters.find((s) => s.id === 'cqrs')!.availability).toBe('ready');
  });

  it('keeps the last good copy when GitHub can’t be reached', async () => {
    serve();
    await refreshGallery();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(refreshGallery()).rejects.toBeInstanceOf(GalleryRefreshError);
    const cached = await loadGallery();
    expect(cached?.starters.filter((s) => s.availability === 'ready')).toHaveLength(vendoredCatalog().starters.length);
  });

  it('marks nothing on first load, then what is new or changed until it is looked at', async () => {
    serve();
    const first = await refreshGallery();
    expect(first.starters.some((s) => s.mark)).toBe(false);

    const catalog = JSON.parse(vendoredCatalogText()) as { starters: Record<string, unknown>[] };
    const monolith = vendoredCatalog().starters.find((s) => s.id === 'monolith')!;
    const changed = vendoredText(monolith).replace('"title": "Monolith"', '"title": "Monolith, revised"');
    const next = {
      ...catalog,
      starters: [
        ...catalog.starters.map((s) => (s.id === 'monolith' ? { ...s, sha256: sha256(changed), bytes: Buffer.byteLength(changed) } : s)),
        { ...catalog.starters[0], id: 'brand-new', name: 'Brand new', path: 'starters/architectures/brand-new/brand-new.draftcanvas' },
      ],
    };
    serve({ 'catalog.json': JSON.stringify(next), [monolith.path]: changed, 'starters/architectures/brand-new/brand-new.draftcanvas': vendoredText(monolith) });
    const second = await refreshGallery();
    expect(second.starters.find((s) => s.id === 'monolith')!.mark).toBe('updated');
    expect(second.starters.find((s) => s.id === 'brand-new')!.mark).toBe('new');
    expect(second.starters.find((s) => s.id === 'cqrs')!.mark).toBeUndefined();

    await markStarterSeen(second.starters.find((s) => s.id === 'monolith')!);
    expect((await loadGallery())!.starters.find((s) => s.id === 'monolith')!.mark).toBeUndefined();
  });

  it('shows a starter for a newer app as needing an update, without downloading it', async () => {
    const catalog = JSON.parse(vendoredCatalogText()) as { starters: Record<string, unknown>[] };
    const fetch = serve({ 'catalog.json': JSON.stringify({ ...catalog, starters: catalog.starters.map((s) => (s.id === 'kappa' ? { ...s, formatVersion: 999 } : s)) }) });
    const snapshot = await refreshGallery();
    expect(snapshot.starters.find((s) => s.id === 'kappa')!.availability).toBe('needs-update');
    expect(fetch.mock.calls.some(([url]) => String(url).includes('kappa'))).toBe(false);
  });
});

describe('a starter on the canvas', () => {
  it('pastes a whole starter with fresh ids, its flows re-pointed at the copies', () => {
    const file = vendoredFile('saga-orchestration');
    const { doc, nodeIds, flowIds } = pasteDocument(createDocument('Here'), file, { x: 100, y: 50 });
    expect(nodeIds).toHaveLength(file.nodes.length);
    expect(flowIds).toHaveLength(file.flows.length);
    const edgeIds = new Set(doc.edges.map((e) => e.id));
    for (const flow of doc.flows) {
      expect(file.flows.some((f) => f.id === flow.id)).toBe(false);
      for (const step of flow.steps) expect(edgeIds.has(step.edgeId!)).toBe(true);
    }
    expect(doc.nodes.some((n) => file.nodes.some((m) => m.id === n.id))).toBe(false);
  });

  it('opens as a canvas that remembers the starter and version it began as, through save and reopen', async () => {
    serve();
    const snapshot = await refreshGallery();
    const entry = snapshot.starters.find((s) => s.id === 'cqrs')!;
    const file = (await starterFile(entry))!;
    const canvas = canvasFromStarter(entry, file);
    expect(canvas.metadata.title).toBe('CQRS');
    expect(canvas.metadata.origin).toEqual({ starter: 'cqrs', sha256: entry.sha256 });
    const reopened = parseDocument(serializeDocument(canvas));
    expect(reopened.ok && reopened.document.metadata.origin).toEqual({ starter: 'cqrs', sha256: entry.sha256 });
    // Anything else in that field is dropped, not trusted.
    const forged = serializeDocument(canvas).replace(entry.sha256, 'not-a-hash');
    const read = parseDocument(forged);
    expect(read.ok && read.document.metadata.origin).toBeUndefined();
  });
});

describe('style packs', () => {
  it('are listed in the catalog beside the starters, and missing from an older one without harm', () => {
    const catalog = vendoredCatalog();
    expect((catalog.styles ?? []).map((entry) => entry.id)).toEqual(['professional', 'geek', 'arena', 'high-seas', 'high-fantasy', 'cyberpunk', 'cute', 'weeb', 'hardwood', 'match-point']);
    for (const entry of catalog.styles ?? []) expect(entry.path).toBe(`styles/${entry.id}/${entry.id}.draftstyle`);
    const older = JSON.parse(vendoredCatalogText()) as { styles?: unknown };
    delete older.styles;
    const parsed = parseCatalog(JSON.stringify(older));
    expect(parsed.ok && parsed.catalog.styles).toEqual([]);
  });

  it('skips a pack entry it can’t trust and keeps the rest', () => {
    const raw = JSON.parse(vendoredCatalogText()) as { styles: Record<string, unknown>[] };
    const good = raw.styles[0]!;
    raw.styles = [
      good,
      { ...good, id: 'elsewhere', path: 'https://example.test/evil.draftstyle' },
      { ...good, id: 'climbing', path: 'styles/../../etc/passwd.draftstyle' },
      { ...good, id: 'a-diagram', path: 'starters/patterns/saga/saga.draftcanvas' },
      { ...good, id: 'unhashed', sha256: 'nope' },
      { ...good, id: 'huge', bytes: 50_000_000 },
      { ...good },
    ];
    const parsed = parseCatalog(JSON.stringify(raw));
    expect(parsed.ok && parsed.catalog.styles?.map((entry) => entry.id)).toEqual([good.id]);
  });

  it('are fetched from the gallery repository, checked, and read back as styles', async () => {
    const fetch = serve();
    const snapshot = await refreshGallery();
    expect(snapshot.styles).toHaveLength(10);
    expect(snapshot.styles.every((pack) => pack.availability === 'ready')).toBe(true);
    for (const [url] of fetch.mock.calls) expect(String(url).startsWith(GALLERY_BASE)).toBe(true);

    const cute = snapshot.styles.find((pack) => pack.id === 'cute')!;
    const file = await stylePackFile(cute);
    expect(file?.name).toBe('Cute');
    // A drawing for every kind of shape, and the backdrop.
    expect(file?.style.assets?.length).toBe(35);
    // Kept through a reload of the gallery from its cache, with no request made.
    fetch.mockClear();
    expect((await loadGallery())?.styles.map((pack) => pack.id)).toEqual(snapshot.styles.map((pack) => pack.id));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a pack that doesn’t match its hash, and one that isn’t a style', async () => {
    const catalog = vendoredCatalog();
    const [professional, geek] = catalog.styles!;
    const diagram = vendoredText(catalog.starters[0]!);
    // The second is served a diagram under the hash of that diagram: it matches, and still is no style.
    const raw = JSON.parse(vendoredCatalogText()) as { styles: Record<string, unknown>[] };
    raw.styles[1] = { ...raw.styles[1], sha256: sha256(diagram), bytes: Buffer.byteLength(diagram) };
    serve({ 'catalog.json': JSON.stringify(raw), [professional!.path]: `${vendoredText(professional!)} `, [geek!.path]: diagram });
    const snapshot = await refreshGallery();
    expect(snapshot.styles.find((pack) => pack.id === 'professional')?.availability).toBe('missing');
    expect(snapshot.styles.find((pack) => pack.id === 'geek')?.availability).toBe('missing');
    expect(snapshot.styles.find((pack) => pack.id === 'arena')?.availability).toBe('ready');
    expect(await stylePackFile(professional!)).toBeNull();
  });
});

describe('the gallery, as the interface sees it', () => {
  it('stays busy from "Load starters" until the starters arrive, however the list is opened meanwhile', async () => {
    serve();
    const { useGalleryStore } = await import('../src/store/galleryStore');
    useGalleryStore.setState({ enabled: false, status: 'idle', snapshot: null, failure: null });
    // What a list would have shown at each moment: nothing downloaded and not busy reads as a failure.
    const stranded: string[] = [];
    const stop = useGalleryStore.subscribe((state) => {
      if (state.enabled && !state.snapshot && state.status === 'idle' && !state.failure) stranded.push('idle with nothing');
    });
    // "Load starters", and the list it opens reading the copy on this device at the same moment.
    const enabling = useGalleryStore.getState().enable();
    const opening = useGalleryStore.getState().load();
    await Promise.all([enabling, opening]);
    stop();
    expect(stranded).toEqual([]);
    expect(useGalleryStore.getState()).toMatchObject({ status: 'idle', failure: null });
    expect(useGalleryStore.getState().snapshot?.starters.length).toBeGreaterThan(0);
    await useGalleryStore.getState().disable();
  });
});
