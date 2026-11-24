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

  it('says what the outage does to each flow', () => {
    const outage = readDiagram(starter, { outage: { element: 'external' } }, 'r', 'd').outage as OutageRead & { flows: unknown[] };

    expect(outage.flows).toEqual([
      { id: 'flow1', state: 'unaffected', of: 4, text: 'Update a projection carries on.' },
      { id: 'flow2', state: 'breaks', step: 3, of: 4, text: 'Step 3 of 4 in Reach an external system (Integration Queue → Integration Worker) fails. 1 later step is hit too.' },
      { id: 'flow3', state: 'recovery', of: 2, text: 'Handle a failed delivery runs over a fallback or dead-letter route this outage brings into use.' },
    ]);
  });

  it('reviews every shape when no element is named', () => {
    const outage = readDiagram(starter, { outage: {} }, 'r', 'd').outage as { basis: string; review: { id: string; flows: string[]; open: number; text: string }[]; oneInstanceOfSeveral: string[]; nothingElseChanges: string[] };

    expect(outage.basis).toMatch(/drawing alone/);
    expect(outage.basis).toMatch(/not by severity/);
    expect(outage.review[0]).toMatchObject({ id: 'producer', reaches: [], flows: ['flow1', 'flow2', 'flow3'], affected: 7, open: 1 });
    expect(outage.review.map((entry) => entry.id)).toContain('external');
    expect(outage.oneInstanceOfSeveral).toEqual([]);
    const connectors = (outage as unknown as { connectors: { id: string; open: number }[] }).connectors;
    expect(connectors.map((entry) => entry.id)).toEqual(expect.arrayContaining(['publish', 'call-external', 'dead-letter']));
  });

  it('reads a connector down, with both of its ends up', () => {
    const outage = readDiagram(starter, { outage: { connector: 'consume-projection' } }, 'r', 'd').outage as OutageRead & { connector: string };

    expect(outage.connector).toBe('consume-projection');
    expect(outage.headline).toMatch(/^Projection Queue can't reach Projection Worker\./);
    expect(outage.affected).toEqual(expect.arrayContaining([{ id: 'projection-queue', state: 'holding' }, { id: 'projection-worker', state: 'quiet' }]));
    expect(outage.affected.some((item) => item.state === 'down')).toBe(false);
    expect(() => readDiagram(starter, { outage: { connector: 'nope' } }, 'r', 'd')).toThrow(/not a relationship of this view/);
  });

  it('passes on the vendor page a quoted product behaviour was read from', () => {
    const named = { ...starter, nodes: starter.nodes.map((item) => (item.id === 'projection-queue' ? { ...item, technology: 'Amazon SQS' } : item)) };
    const outage = readDiagram(named, { outage: { element: 'projection-worker' } }, 'r', 'd').outage as { notes: { text: string; sources?: string[] }[] };

    expect(outage.notes[0]?.sources).toEqual(['https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html']);
    expect(outage.notes.slice(1).every((note) => note.sources === undefined)).toBe(true);
  });

  it('refuses an element that is not in the view', () => {
    expect(() => readDiagram(starter, { outage: { element: 'nope' } }, 'r', 'd')).toThrow(/not an element or group of this view/);
  });
});
