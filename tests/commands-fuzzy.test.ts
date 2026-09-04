import { describe, expect, it } from 'vitest';
import { fuzzyMatch, rank } from '../src/commands/fuzzy';
import type { CommandOption } from '../src/commands/types';

const noop = () => {};
const entry = (title: string, keywords?: string[]): CommandOption => ({
  id: title.toLowerCase().replace(/\W+/g, '-'),
  title,
  keywords,
  run: noop,
});

const CATALOG: CommandOption[] = [
  entry('Add Text', ['label']),
  entry('Add Note', ['remark', 'sticky']),
  entry('Add Code', ['snippet', 'json']),
  entry('Add Service', ['api', 'app']),
  entry('Add Data Store', ['db', 'database', 'sql']),
  entry('Add Queue', ['topic', 'stream']),
  entry('Add Actor', ['user', 'person']),
  entry('Connect to…', ['link', 'edge', 'arrow']),
  entry('Spotlight selection', ['focus', 'highlight']),
  entry('Start presentation', ['present', 'walkthrough']),
  entry('Canvas settings…', ['background', 'personality']),
  entry('Keyboard shortcuts', ['help']),
];

const top = (query: string) => rank(query, CATALOG).map((row) => row.entry.title);

describe('fuzzyMatch', () => {
  it('requires every query character in order', () => {
    expect(fuzzyMatch('ads', 'Add Data Store')).not.toBeNull();
    expect(fuzzyMatch('sda', 'Add Data Store')).toBeNull();
    expect(fuzzyMatch('xyz', 'Add Data Store')).toBeNull();
  });

  it('matches everything on an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
    expect(rank('', CATALOG)).toHaveLength(CATALOG.length);
  });

  it('reports the indices it matched, for highlighting', () => {
    expect(fuzzyMatch('ad', 'Add Data Store')?.indices).toEqual([0, 1]);
    expect(fuzzyMatch('ds', 'Add Data Store')?.indices).toEqual([4, 9]);
  });

  it('prefers word starts and consecutive runs over scattered letters', () => {
    const wordStarts = fuzzyMatch('ds', 'Data Store')!.score;
    const scattered = fuzzyMatch('ds', 'Address book')!.score;
    expect(wordStarts).toBeGreaterThan(scattered);
    const prefix = fuzzyMatch('spot', 'Spotlight selection')!.score;
    const later = fuzzyMatch('spot', 'Hotspot list')!.score;
    expect(prefix).toBeGreaterThan(later);
  });
});

describe('rank — the roadmap abbreviations', () => {
  it('"db" surfaces Add Data Store first', () => {
    expect(top('db')[0]).toBe('Add Data Store');
  });

  it('"conn" surfaces Connect to… first', () => {
    expect(top('conn')[0]).toBe('Connect to…');
  });

  it('"spot" surfaces Spotlight selection first', () => {
    expect(top('spot')[0]).toBe('Spotlight selection');
  });

  it('"serv" surfaces Add Service first', () => {
    expect(top('serv')[0]).toBe('Add Service');
  });

  it('a title hit outranks a keyword-only hit on a tie', () => {
    const rows = rank('present', CATALOG);
    expect(rows[0]!.entry.title).toBe('Start presentation');
  });

  it('drops entries that do not match, and a shorter title wins an otherwise equal match', () => {
    const rows = rank('add', CATALOG);
    expect(rows.every((row) => row.entry.title.startsWith('Add'))).toBe(true);
    expect(rows).toHaveLength(CATALOG.filter((c) => c.title.startsWith('Add')).length);
    const lengths = rows.map((row) => row.entry.title.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });

  it('applies a caller-supplied bonus without reordering a clearly better text match', () => {
    const rows = rank('spot', CATALOG, (candidate) => (candidate.title === 'Add Note' ? 1 : 0));
    expect(rows[0]!.entry.title).toBe('Spotlight selection');
  });
});
