import { describe, expect, it } from 'vitest';
import { noteText } from '../src/sequence/mermaid';
import { noteLines, wrapNoteLines } from '../src/sequence/wrap';

/**
 * Prose notes are wrapped so one sentence can't stretch a diagram sideways; code is not, because
 * wrapping trims and re-joins words — which flattened a Python or YAML snippet's indentation and
 * split its statements at arbitrary spaces.
 */

const yaml = ['retry:', '  attempts: 3', '  backoff:', '    base: 200ms', '    max: 5s'].join('\n');

describe('noteLines', () => {
  it('keeps a code note’s lines and indentation exactly, however long', () => {
    const long = `    note: ${'word '.repeat(30)}end`;
    expect(noteLines(`${yaml}\n${long}  `, true)).toEqual([...yaml.split('\n'), long]);
  });

  it('still wraps prose', () => {
    const prose = 'word '.repeat(30).trim();
    expect(noteLines(prose, false)).toEqual(wrapNoteLines(prose));
    expect(noteLines(prose, false).length).toBeGreaterThan(1);
  });
});

describe('code notes as Mermaid note text', () => {
  it('never re-wraps a long code line', () => {
    const line = `command: [${'"--flag", '.repeat(15)}"--last"]`;
    expect(noteText(line, true)).not.toContain('<br/>');
  });
});
