import { describe, expect, it, vi } from 'vitest';
import { createAttachment, createDocument, createEdge, createNode } from '../src/document/factory';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { docsLevels, docsTitleFor, levelExists, renderDocsImage } from '../src/export/docs/image';
import { DEFAULT_DOCS_SETTINGS, MARKER_OPEN, markerElement, readMarker, sameSettings, type DocsSettings } from '../src/export/docs/marker';
import { bundleNames, docsBundle } from '../src/export/docs/bundle';
import { unzipFiles } from '../src/export/zip';
import { renderDocumentSvg } from '../src/render/svg/document';

// No icon fetches and no stored background in a unit test: the picture is the renderer's alone.
vi.mock('../src/nodes/technology', async (original) => ({ ...(await original<object>()), loadTechnologyIcons: vi.fn(async () => {}) }));
vi.mock('../src/export/background', async (original) => ({
  ...(await original<object>()),
  resolveExportBackground: vi.fn(async () => undefined),
  withEmbeddedBackground: vi.fn(async (document: DraftDocument) => document),
}));

const decoder = new TextDecoder();

function room(nodes: DraftNode[]): NonNullable<DraftNode['inside']> {
  return { nodes, edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

/** Payments: a gateway and a ledger at the top; the ledger has a level inside with secrets in it. */
function payments(): DraftDocument {
  const vault = createNode({ type: 'database', x: 0, y: 0, text: 'Hidden vault' });
  const ledger = {
    ...createNode({ type: 'service', x: 260, y: 0, text: 'Ledger' }),
    inside: room([vault]),
    attachments: [createAttachment({ type: 'code', language: 'plaintext', code: 'API_KEY=sk_live_do_not_publish' }), createAttachment({ type: 'note', text: 'Private rollout note' })],
  };
  const gateway = createNode({ type: 'service', x: 0, y: 0, text: 'Gateway & “Edge” <v2> 設計' });
  const edge = createEdge({ source: gateway.id, target: ledger.id, label: 'posts entries' });
  return { ...createDocument('Payments'), nodes: [gateway, ledger], edges: [edge] };
}

const top: DocsSettings = { ...DEFAULT_DOCS_SETTINGS };

describe('the docs note', () => {
  it('round-trips, with keys in a fixed order', () => {
    const settings: DocsSettings = { view: ['n_1', 'n_2'], theme: 'dark', style: 'sketch', sync: false };
    const element = markerElement('pay & <ments>.draftcanvas', settings);
    expect(element.startsWith(MARKER_OPEN)).toBe(true);
    expect(element).not.toContain('<ments>');
    expect(markerElement('pay & <ments>.draftcanvas', { ...settings })).toBe(element);
    const read = readMarker(`<svg>${element}<rect/></svg>`);
    expect(read?.source).toBe('pay & <ments>.draftcanvas');
    expect(sameSettings(read!.settings, settings)).toBe(true);
  });

  it('is refused when absent, damaged or from an unknown version', () => {
    expect(readMarker('<svg><rect/></svg>')).toBeNull();
    expect(readMarker(`<svg>${MARKER_OPEN}{not json</metadata></svg>`)).toBeNull();
    expect(readMarker(`<svg>${MARKER_OPEN}{"v":2,"source":"a","view":[],"theme":"light","style":"clean","sync":true}</metadata></svg>`)).toBeNull();
    expect(readMarker(`<svg>${MARKER_OPEN}{"v":1,"source":"a","view":[1],"theme":"light","style":"clean","sync":true}</metadata></svg>`)).toBeNull();
    expect(readMarker(`<svg>${MARKER_OPEN}{"v":1,"source":"a","view":[],"theme":"neon","style":"clean","sync":true}</metadata></svg>`)).toBeNull();
    expect(readMarker(`<svg>${MARKER_OPEN}{"v":1,"source":"a","view":[],"theme":"light","style":"constructor","sync":true}</metadata></svg>`)).toBeNull();
  });
});

describe('the docs image', () => {
  it('is the export renderer’s picture, with a title and the note but never the diagram inside', async () => {
    const file = payments();
    const rendered = await renderDocsImage(file, 'payments.draftcanvas', top);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const plain = renderDocumentSvg(file, { theme: 'light', preset: 'clean', includeBackground: true, openPoints: true, idScope: 'docs-top' });
    // Everything after the added header is the ordinary export, byte for byte.
    expect(rendered.svg.endsWith(plain.svg.slice(plain.svg.indexOf('>') + 1))).toBe(true);
    expect(rendered.svg).toContain('<title>Payments</title>');
    expect(rendered.svg).toContain('role="img"');
    expect(readMarker(rendered.svg)?.source).toBe('payments.draftcanvas');
    // Nothing that would let the image reopen as the diagram, nor anything from a level not shown.
    expect(rendered.svg).not.toContain('<metadata id="draftcanvas">');
    expect(rendered.svg).not.toContain('"nodes"');
    expect(rendered.svg).not.toContain('Hidden vault');
    expect(rendered.svg).not.toContain('sk_live_do_not_publish');
    expect(rendered.svg).not.toContain('Private rollout note');
    expect(rendered.svg).not.toMatch(/<script|<foreignObject|javascript:/i);
  });

  it('draws the same bytes every time, and the same from the saved file as from memory', async () => {
    const file = payments();
    const a = await renderDocsImage(file, 'payments.draftcanvas', top);
    const b = await renderDocsImage(file, 'payments.draftcanvas', top);
    const reread = deserializeDocument(serializeDocument(file));
    expect(reread.ok).toBe(true);
    const c = await renderDocsImage(reread.ok ? reread.document : file, 'payments.draftcanvas', top);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(b.svg).toBe(a.svg);
      expect(c.svg).toBe(a.svg);
    }
  });

  it('keeps unusual names as text, escaped', async () => {
    const rendered = await renderDocsImage(payments(), 'payments.draftcanvas', top);
    expect(rendered.ok && rendered.svg).toContain('設計');
    expect(rendered.ok && rendered.svg).not.toContain('<v2>');
  });

  it('shows the chosen level, whatever the editor shows, and says when it is gone', async () => {
    const file = payments();
    const ledger = file.nodes[1]!;
    expect(docsLevels(file).map((level) => level.label)).toEqual(['Whole diagram', 'Inside Ledger']);
    expect(docsTitleFor(file, [ledger.id])).toBe('Payments / Ledger');
    // A file named after the system it opens doesn't say the name twice.
    expect(docsTitleFor({ ...file, metadata: { ...file.metadata, title: 'ledger' } }, [ledger.id])).toBe('ledger');
    const inside = await renderDocsImage(file, 'payments.draftcanvas', { ...top, view: [ledger.id] });
    expect(inside.ok && inside.svg).toContain('Hidden vault');
    expect(inside.ok && inside.svg).not.toContain('Gateway');
    expect(inside.ok && inside.svg).toContain('<title>Payments / Ledger</title>');

    const without = { ...file, nodes: file.nodes.filter((node) => node.id !== ledger.id), edges: [] };
    expect(levelExists(without, [ledger.id])).toBe(false);
    expect(await renderDocsImage(without, 'payments.draftcanvas', { ...top, view: [ledger.id] })).toEqual({ ok: false, reason: 'missing-view' });
  });

  it('follows the look and the theme it was given', async () => {
    const light = await renderDocsImage(payments(), 'p.draftcanvas', top);
    const dark = await renderDocsImage(payments(), 'p.draftcanvas', { ...top, theme: 'dark' });
    expect(light.ok && dark.ok && light.svg !== dark.svg).toBe(true);
  });

  it('keeps a title with characters XML forbids readable', async () => {
    const file = { ...payments(), metadata: { ...payments().metadata, title: 'Pay\u0001ments\u000b' } };
    const rendered = await renderDocsImage(file, 'payments.draftcanvas', top);
    expect(rendered.ok && rendered.svg).toContain('<title>Payments</title>');
    expect(rendered.ok && [...rendered.svg].some((char) => char.charCodeAt(0) < 0x20 && !'\t\n\r'.includes(char))).toBe(false);
  });

  it('draws an empty diagram as an empty card', async () => {
    const rendered = await renderDocsImage(createDocument(''), 'untitled.draftcanvas', top);
    expect(rendered.ok && rendered.svg).toContain('<title>Architecture diagram</title>');
  });
});

describe('the download for docs', () => {
  it('holds the picture and its editable source in diagrams/, as the Markdown says', async () => {
    const file = payments();
    const names = bundleNames(file);
    expect(names).toEqual({ image: 'payments.svg', source: 'payments.draftcanvas', archive: 'payments-docs.zip', imagePath: 'diagrams/payments.svg' });
    const entries = unzipFiles(await docsBundle(file, { ...top, sync: true }));
    expect(entries.map((entry) => entry.name).sort()).toEqual(['diagrams/payments.draftcanvas', 'diagrams/payments.svg']);
    const svg = decoder.decode(entries.find((entry) => entry.name.endsWith('.svg'))!.data);
    // A download has no file to follow: always a snapshot.
    expect(readMarker(svg)?.settings.sync).toBe(false);
    const source = deserializeDocument(decoder.decode(entries.find((entry) => entry.name.endsWith('.draftcanvas'))!.data));
    expect(source.ok && source.document.nodes.length).toBe(2);
  });
});
