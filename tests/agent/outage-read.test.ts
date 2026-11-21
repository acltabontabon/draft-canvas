import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDiagram } from '../../src/agent/read';
import { parseDocument } from '../../src/document/validate';

/*
 * An agent asks the same question the canvas does and gets the same reading, as facts: what fails,
 * what absorbs it, and — as `open` — what the drawing leaves for the person to decide.
 */
const parsed = parseDocument(
  readFileSync(join(process.cwd(), 'tests/fixtures/outage/event-driven.draftcanvas'), 'utf8'),
);
if (!parsed.ok) throw new Error(parsed.error);
const starter = parsed.document;

type OutageRead = { headline: string; basis: string; affected: { id: string; state: string }[]; unaffected: string[]; notes: { kind: string; ids: string[]; text: string; open?: string }[] };

describe('read_diagram outage', () => {
  it('is absent unless asked for', () => {
    expect(readDiagram(starter, {}, 'r', 'd').outage).toBeUndefined();
  });

  it('returns what the editor’s outage walk reads, with open questions and no changes', () => {
    const outage = readDiagram(starter, { outage: { element: 'external' } }, 'r', 'd').outage as OutageRead;

    expect(outage.headline).toBe('External System is down. Producer Service, Domain Events and 3 more carry on.');
    expect(outage.basis).toMatch(/drawing alone/);
    expect(outage.affected).toEqual([
      { id: 'external', state: 'down' },
      { id: 'integration-worker', state: 'failing' },
      { id: 'integration-queue', state: 'retrying' },
      { id: 'integration-dlq', state: 'catching' },
    ]);
    expect(outage.unaffected).toContain('producer');
    expect(outage.notes.filter((note) => note.kind === 'question').map((note) => note.open)).toEqual([
      'What should Integration Worker do while External System is down?',
      'How are messages in the dead-letter queue replayed once External System is back?',
    ]);
  });

  it('refuses an element that is not in the view', () => {
    expect(() => readDiagram(starter, { outage: { element: 'nope' } }, 'r', 'd')).toThrow(/not an element or group of this view/);
  });
});
