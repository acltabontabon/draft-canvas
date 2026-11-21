import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
}));

import { applyOutageFix, outageCandidate, outageFixLabel, startOutage, toggleOutage } from '../src/commands/outage';
import { parseDocument } from '../src/document/validate';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { outageEdgeOf, outageIn, outageNodeReading, roomMayHaveOutage, runtimeOf } from '../src/store/outage';

/*
 * The outage walk through the real store: what taking a shape down sets, what each shape and
 * connector then reads, and that answering a question is an ordinary, undoable edit the walk
 * reads again at once.
 */

const parsed = parseDocument(
  readFileSync(join(process.cwd(), 'tests/fixtures/outage/event-driven.draftcanvas'), 'utf8'),
);
if (!parsed.ok) throw new Error(parsed.error);
const starter = parsed.document;
const store = useEditorStore;
const notes = () => outageIn(store.getState())?.notes.map((note) => note.note) ?? [];

beforeEach(() => {
  preferences.clear();
  __resetInteraction();
  store.getState().setDocument(structuredClone(starter));
  store.getState().setMode('edit');
  store.getState().endOutage();
  store.getState().setSelection({ nodes: [], edges: [] });
});

describe('outage walk in the store', () => {
  it('reads nothing until a walk is open, and leaves the diagram as drawn until a shape is picked', () => {
    expect(roomMayHaveOutage(store.getState())).toBe(true);
    expect(runtimeOf(store.getState())).toBeNull();
    expect(outageNodeReading(store.getState(), 'external')).toBeNull();

    store.getState().startOutage();
    expect(store.getState().outage).toEqual({ active: true, down: null, whole: false });
    expect(outageIn(store.getState())).toBeNull();
    expect(outageNodeReading(store.getState(), 'external')).toBeNull();
    expect(outageEdgeOf(store.getState(), 'call-external')).toBeNull();
  });

  it('says what the outage does to each shape and connector', () => {
    store.getState().takeDown('external');

    const state = store.getState();
    expect(outageNodeReading(state, 'external')).toBe('down');
    expect(outageNodeReading(state, 'integration-worker')).toBe('failing');
    expect(outageNodeReading(state, 'integration-queue')).toBe('retrying');
    expect(outageNodeReading(state, 'integration-dlq')).toBe('catching');
    expect(outageNodeReading(state, 'producer')).toBe('lit');
    expect(outageEdgeOf(state, 'call-external')).toBe('failing');
    expect(outageEdgeOf(state, 'dead-letter')).toBe('recovery');
    expect(outageEdgeOf(state, 'publish')).toBe('flow');
  });

  it('keeps one reading while a shape is dragged, and a fresh one when the graph changes', () => {
    store.getState().takeDown('external');
    const before = outageIn(store.getState());

    store.getState().updateNodeById('producer', { x: 900 });
    expect(outageIn(store.getState())).toBe(before);

    store.getState().updateNodeById('integration-worker', { replicas: 2 });
    expect(outageIn(store.getState())).not.toBe(before);
  });

  it('ends when presenting starts, and never starts while presenting', () => {
    store.getState().takeDown('external');
    store.getState().setMode('present');
    expect(store.getState().outage.active).toBe(false);

    store.getState().takeDown('external');
    store.getState().startOutage();
    expect(store.getState().outage.active).toBe(false);
  });

  it('ignores a shape that is not there', () => {
    store.getState().takeDown('nope');
    expect(store.getState().outage.active).toBe(false);
  });
});

describe('ways in', () => {
  it('takes the selected shape down, or opens the walk to wait for one', () => {
    toggleOutage();
    expect(store.getState().outage).toEqual({ active: true, down: null, whole: false });
    toggleOutage();
    expect(store.getState().outage.active).toBe(false);

    store.getState().setSelection({ nodes: ['external'], edges: [] });
    expect(outageCandidate(store.getState())).toBe('external');
    startOutage();
    expect(store.getState().outage.down).toBe('external');
  });
});

describe('answering a question by drawing it', () => {
  it('draws the replay route as one undoable step, and the walk reads it at once', () => {
    store.getState().takeDown('external');
    const question = outageIn(store.getState())!.notes.find((note) => note.fix?.kind === 'replay')!;
    expect(outageFixLabel(question.fix!)).toBe('Draw the replay route');

    applyOutageFix(question.fix!);
    expect(store.getState().document.edges.at(-1)).toMatchObject({ source: 'integration-dlq', target: 'integration-queue', semantic: 'deliversTo', label: 'replays' });
    expect(notes()).toContain("replay from here once it's back");
    expect(notes()).not.toContain('messages stay here — no replay drawn');
    // Asking twice draws nothing more.
    applyOutageFix(question.fix!);
    expect(store.getState().document.edges).toHaveLength(starter.edges.length + 1);

    store.getState().undo();
    expect(store.getState().document.edges).toHaveLength(starter.edges.length);
    expect(notes()).toContain('messages stay here — no replay drawn');
    // The walk is a view: undoing the edit leaves it open.
    expect(store.getState().outage.down).toBe('external');
  });

  it('runs two instances of a single one, which then loses one before all', () => {
    store.getState().takeDown('projection-worker');
    const question = outageIn(store.getState())!.notes.find((note) => note.fix?.kind === 'instances')!;

    applyOutageFix(question.fix!);
    expect(store.getState().document.nodes.find((node) => node.id === 'projection-worker')?.replicas).toBe(2);
    expect(outageIn(store.getState())?.instances).toEqual({ down: 1, of: 2 });
    expect(notes()).toEqual(['1 of 2 still running']);

    store.getState().takeDown('projection-worker', true);
    expect(outageIn(store.getState())?.headline).toMatch(/^All 2 Projection Worker instances are down\./);
  });

  it('adds a dead-letter queue where a failing consumer had none', () => {
    const { removeDeadLetterQueue, takeDown } = store.getState();
    removeDeadLetterQueue('integration-queue');
    takeDown('external');
    const question = outageIn(store.getState())!.notes.find((note) => note.fix?.kind === 'dead-letter')!;
    expect(question.note).toBe('keeps redelivering — no dead-letter drawn');

    applyOutageFix(question.fix!);
    expect(notes().some((note) => note.startsWith('dead-letters after'))).toBe(true);
  });
});
