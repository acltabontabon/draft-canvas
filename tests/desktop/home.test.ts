import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes } from '../../src/document/operations';
import { serializeDocument } from '../../src/export/project';
import { titleOf } from '../../src/desktop/controller';
import { thumbnailOf } from '../../src/desktop/thumbnails';
import type { BrowseTile } from '../../src/desktop/ui/DeskBrowse';
import { sortTiles } from '../../src/desktop/ui/tiles';

const withServices = (title: string, count: number) =>
  serializeDocument(
    addNodes(
      createDocument(title),
      Array.from({ length: count }, (_, i) => createNode({ type: 'service', x: i * 220, y: 0 })),
    ),
  );

describe('a draft’s title on Home', () => {
  it('is read from the head of the file, as the app writes it', () => {
    expect(titleOf(serializeDocument(createDocument('Login flow')))).toBe('Login flow');
  });

  it('survives quotes, escapes and other scripts in the title', () => {
    expect(titleOf(serializeDocument(createDocument('The "fast" path — 設計 \\ v2')))).toBe('The "fast" path — 設計 \\ v2');
  });

  it('is nothing for a blank title or text that isn’t a diagram', () => {
    expect(titleOf(serializeDocument(createDocument('   ')))).toBeNull();
    expect(titleOf('{ not a diagram')).toBeNull();
  });
});

describe('a file’s thumbnail on Home', () => {
  it('is the diagram’s own topology', () => {
    const drawn = thumbnailOf(withServices('Payments', 3));
    expect(drawn.state).toBe('drawn');
    if (drawn.state !== 'drawn') return;
    expect(drawn.shape.shape.nodes).toHaveLength(3);
    expect(drawn.shape.boxes).toHaveLength(3);
  });

  it('keeps no words from the diagram, only its shape', () => {
    const drawn = thumbnailOf(withServices('Top secret payments', 2));
    expect(JSON.stringify(drawn)).not.toContain('secret');
  });

  it('is a blank sheet for an empty canvas, a file that isn’t a diagram, or nothing at all', () => {
    expect(thumbnailOf(serializeDocument(createDocument('Empty'))).state).toBe('blank');
    expect(thumbnailOf('{ broken').state).toBe('blank');
    expect(thumbnailOf(null).state).toBe('blank');
  });
});

describe('the order of diagrams in Browse', () => {
  const tile = (name: string, when?: number, kind: BrowseTile['kind'] = 'document'): BrowseTile => ({
    entryKey: `${kind}:${name}`,
    kind,
    name,
    when,
    label: name,
    description: '',
    haystack: name.toLowerCase(),
    onOpen: () => {},
  });
  const names = (tiles: BrowseTile[]) => tiles.map((t) => t.name);
  const list = [tile('beta', 10), tile('Alpha', 30), tile('zeta folder', undefined, 'folder'), tile('Step 10', 20), tile('Step 2', 20), tile('archive', undefined, 'folder')];

  it('puts the most recently edited first, folders ahead of them by name', () => {
    expect(names(sortTiles(list, 'edited'))).toEqual(['archive', 'zeta folder', 'Alpha', 'Step 2', 'Step 10', 'beta']);
  });

  it('sorts by name, ignoring case and reading numbers as numbers', () => {
    expect(names(sortTiles(list, 'name'))).toEqual(['archive', 'zeta folder', 'Alpha', 'beta', 'Step 2', 'Step 10']);
  });

  it('leaves the list it was given as it was', () => {
    const before = names(list);
    sortTiles(list, 'name');
    expect(names(list)).toEqual(before);
  });
});
