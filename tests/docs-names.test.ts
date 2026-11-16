import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { markerElement, type DocsSettings } from '../src/export/docs/marker';
import { levelImageNames, levelSlug, pictureFor, picturesOf, type PictureFile } from '../src/export/docs/names';

const settings = (view: string[] = []): DocsSettings => ({ view, theme: 'light', style: 'clean', sync: true });

/** Online store, with Store API inside it and Checkout inside that. */
function store(): { file: DraftDocument; system: DraftNode; api: DraftNode } {
  const file = createDocument('Online store');
  const checkout = createNode({ type: 'component', x: 0, y: 0, text: 'Checkout' });
  const api = { ...createNode({ type: 'service', x: 0, y: 0, text: 'Store API' }), inside: { nodes: [checkout], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
  const system = { ...createNode({ type: 'service', x: 0, y: 0, text: 'Online store' }), inside: { nodes: [api], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
  file.nodes.push(system);
  return { file, system, api };
}

const ours = (name: string, source: string, view: string[]): PictureFile => {
  const svg = `<svg>${markerElement(source, settings(view))}</svg>`;
  return { name, state: 'ours', marker: readMarkerJson(svg), svg, modifiedMs: null };
};
const foreign = (name: string): PictureFile => ({ name, state: 'foreign', marker: null, svg: null, modifiedMs: null });
/** What the shell sends as `marker`: the note's JSON, unescaped. */
const readMarkerJson = (svg: string) => svg.slice(svg.indexOf('>', svg.indexOf('<metadata')) + 1, svg.indexOf('</metadata>')).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('level picture names', () => {
  it('names the whole diagram after the file, and a level after its shape', () => {
    const { file, system, api } = store();
    expect(levelImageNames(file, 'online-store', [])).toEqual(['online-store.svg']);
    expect(levelImageNames(file, 'online-store', [system.id])).toEqual(['online-store.online-store.svg']);
    expect(levelImageNames(file, 'online-store', [system.id, api.id])).toEqual(['online-store.store-api.svg', 'online-store.online-store.store-api.svg']);
  });

  it('numbers a level whose shape shares a name with an earlier one, so each has its own file', () => {
    const file = createDocument('Shop');
    const room = (text: string) => ({ ...createNode({ type: 'service', x: 0, y: 0, text }), inside: { nodes: [createNode({ type: 'component', x: 0, y: 0, text: 'X' })], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } });
    const first = room('Service');
    const second = room('Service');
    file.nodes.push(first, second);
    expect(levelImageNames(file, 'shop', [first.id])[0]).toBe('shop.service.svg');
    expect(levelImageNames(file, 'shop', [second.id])[0]).toBe('shop.service-2.svg');
  });

  it('keeps a name within what a disk allows, whatever the script', () => {
    const { file, system } = store();
    const long = { ...file, nodes: [{ ...system, text: '設計'.repeat(40) }] };
    const [name] = levelImageNames(long, '図'.repeat(60), [system.id]);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(240);
  });

  it('makes a file-name part of any shape name, never with a dot', () => {
    expect(levelSlug('Orders API (v2.1)')).toBe('orders-api-v2-1');
    expect(levelSlug('設計 図')).toBe('設計-図');
    expect(levelSlug('  ***  ')).toBe('level');
  });
});

describe('finding a level’s picture', () => {
  it('is the picture whose note names the level, whatever it is called', () => {
    const { file, system } = store();
    // Published when the shape had another name; still this level's.
    const files = [ours('online-store.svg', 'online-store.draftcanvas', []), ours('online-store.shop.svg', 'online-store.draftcanvas', [system.id])];
    expect(pictureFor(files, file, 'online-store', [system.id])).toMatchObject({ state: 'ours', name: 'online-store.shop.svg' });
    expect(pictureFor(files, file, 'online-store', [])).toMatchObject({ state: 'ours', name: 'online-store.svg' });
  });

  it('takes the next name when the first is something else’s, and never replaces it', () => {
    const { file, system, api } = store();
    const nested = [system.id, api.id];
    expect(pictureFor([foreign('online-store.store-api.svg')], file, 'online-store', nested)).toEqual({ state: 'none', name: 'online-store.online-store.store-api.svg' });
    const both = [foreign('online-store.store-api.svg'), ours('online-store.online-store.store-api.svg', 'other.draftcanvas', [])];
    expect(pictureFor(both, file, 'online-store', nested)).toEqual({ state: 'none', name: 'online-store.store-api-2.svg' });
    const all = [...both, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => foreign(`online-store.store-api-${n}.svg`))];
    expect(pictureFor(all, file, 'online-store', nested)).toEqual({ state: 'taken', name: 'online-store.store-api.svg', why: 'foreign' });
    expect(pictureFor([ours('online-store.svg', 'online-store.v2.draftcanvas', [])], file, 'online-store', [])).toEqual({ state: 'taken', name: 'online-store.svg', why: 'other' });
  });

  it('matches names as a case-insensitive disk would', () => {
    const { file } = store();
    expect(pictureFor([foreign('Online-Store.svg')], file, 'online-store', [])).toMatchObject({ state: 'taken' });
  });

  it('counts only pictures drawn from this diagram as its own', () => {
    const files = [ours('payments.svg', 'payments.draftcanvas', []), ours('payments.v2.svg', 'payments.v2.draftcanvas', []), foreign('payments.notes.svg')];
    expect(picturesOf(files, 'payments').map((picture) => picture.name)).toEqual(['payments.svg']);
  });
});
