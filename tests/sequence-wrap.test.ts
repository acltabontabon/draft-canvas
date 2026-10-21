import { describe, expect, it } from 'vitest';
import { toMermaid } from '../src/sequence/mermaid';
import { toPlantUml } from '../src/sequence/plantuml';
import type { SequenceModel, SequenceNote } from '../src/sequence/types';
import { isCodeNote, noteLines, wrapNoteLines } from '../src/sequence/wrap';

/**
 * Prose notes are wrapped so one sentence can't stretch a diagram sideways; code is not, because
 * wrapping trims and re-joins words — which flattened a Python or YAML snippet's indentation and
 * split its statements at arbitrary spaces.
 */

const yaml = ['retry:', '  attempts: 3', '  backoff:', '    base: 200ms', '    max: 5s'].join('\n');

function modelWith(note: Omit<SequenceNote, 'kind' | 'order' | 'participantIds' | 'sourceFlowId'>): SequenceModel {
  return {
    title: '',
    participants: [{ id: 'P1', alias: 'A', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' }],
    elements: [{ kind: 'note', order: 0, participantIds: ['P1'], sourceFlowId: 'f1', ...note }],
  };
}

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

  it('reads a note as code by the `language` key build.ts always sets on one', () => {
    expect(isCodeNote({ text: 'x', language: undefined })).toBe(true);
    expect(isCodeNote({ text: 'x', noteKind: 'note' })).toBe(false);
  });
});

describe('code notes in the emitters', () => {
  it('writes each YAML line, indented, into the PlantUML note block', () => {
    const out = toPlantUml(modelWith({ text: yaml, language: 'yaml' }));
    for (const line of yaml.split('\n')) expect(out).toContain(`  ${line}\n`);
  });

  it('never re-wraps a long code line for Mermaid', () => {
    const line = `command: [${'"--flag", '.repeat(15)}"--last"]`;
    const out = toMermaid(modelWith({ text: line, language: 'yaml' }));
    expect(out).not.toContain('<br/>');
  });
});
