import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
}));

import { applyOutageFix, keepAsOpenPoint, keptAsOpenPoint, outageCandidate, outageFixLabel, startOutage, toggleOutage } from '../src/commands/outage';
import { LIMITS } from '../src/document/limits';
import { parseDocument } from '../src/document/validate';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { outageEdgeOf, outageIn, outageNodeReading, outageReviewIn, roomMayHaveOutage, runtimeOf } from '../src/store/outage';
import { useUiStore } from '../src/store/uiStore';

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
    expect(store.getState().outage).toEqual({ active: true, down: null, whole: false, cut: null });
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
    expect(store.getState().outage).toEqual({ active: true, down: null, whole: false, cut: null });
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

  it('reads the flows against the outage, and again when a flow is edited', () => {
    store.getState().takeDown('external');
    const before = outageIn(store.getState());
    expect(before?.flows.map((flow) => flow.note)).toEqual(['carries on', 'breaks at step 3 of 4', 'comes into use']);
    // Nothing changed: the same reading, by identity, so the canvas does not re-render.
    expect(outageIn(store.getState())).toBe(before);

    store.getState().renameFlow('flow2', 'Call the provider');
    expect(outageIn(store.getState())?.flows[1]?.text).toMatch(/^Step 3 of 4 in Call the provider /);
  });

  it('reviews every shape only while a walk is open and nothing is down, and keeps the reading', () => {
    expect(outageReviewIn(store.getState())).toBeNull();

    store.getState().startOutage();
    const review = outageReviewIn(store.getState());
    expect(review?.entries.length).toBeGreaterThan(0);
    // The same reading by identity, so a selection or a drag does not work it out again.
    expect(outageReviewIn(store.getState())).toBe(review);
    const moved = store.getState().document.nodes.map((item, index) => (index === 0 ? { ...item, x: item.x + 40 } : item));
    store.setState((state) => ({ document: { ...state.document, nodes: moved } }));
    expect(outageReviewIn(store.getState())).toBe(review);

    store.getState().takeDown(review!.entries[0]!.id);
    expect(outageReviewIn(store.getState())).toBeNull();
  });

  it('takes a connector down in place of a shape, and strikes only that connector', () => {
    store.getState().takeDown('external');
    store.getState().cutConnector('call-external');

    expect(store.getState().outage).toEqual({ active: true, down: null, whole: false, cut: 'call-external' });
    expect(outageIn(store.getState())?.connector).toEqual({ from: ['integration-worker'], to: ['external'] });
    expect(outageEdgeOf(store.getState(), 'call-external')).toBe('cut');
    expect(outageEdgeOf(store.getState(), 'consume-integration')).toBe('failing');
    // The far end is up: unreached, not struck out.
    expect(outageNodeReading(store.getState(), 'external')).toBe('quiet');
    expect(outageReviewIn(store.getState())).toBeNull();

    // A shape taken down next replaces it, and a connector that is gone leaves nothing to read.
    store.getState().takeDown('external');
    expect(store.getState().outage.cut).toBeNull();
    store.getState().cutConnector('not-a-connector');
    expect(store.getState().outage.down).toBe('external');
  });

  it('starts from one selected connector', () => {
    store.getState().setSelection({ nodes: [], edges: ['consume-projection'] });
    startOutage();
    expect(store.getState().outage.cut).toBe('consume-projection');
  });
});

describe('keeping a question as an open point', () => {
  /** The question the walk asks of the dead-letter queue, with nothing kept yet. */
  const replayQuestion = () => outageIn(store.getState())!.notes.find((note) => note.id.startsWith('no-replay'))!;

  it('keeps it once, and knows it is kept, even when a long name was stored cleaned up', () => {
    // An open point is stored trimmed, its blank lines collapsed and cut at its length limit, so
    // the question as asked and the point as kept no longer read alike.
    const name = `External System   \n\n\n\n${'with a long name '.repeat(40)}`;
    store.getState().updateNodeById('external', { text: name });
    store.getState().takeDown('external');
    const question = replayQuestion();
    expect(question.ask!.length).toBeGreaterThan(LIMITS.maxOpenPointContextLength);
    expect(keptAsOpenPoint(question, store.getState().document.openPoints)).toBe(false);

    keepAsOpenPoint(question);
    expect(store.getState().document.openPoints).toHaveLength(1);
    expect(keptAsOpenPoint(replayQuestion(), store.getState().document.openPoints)).toBe(true);
    // A second click is the same question: nothing more is added.
    keepAsOpenPoint(replayQuestion());
    expect(store.getState().document.openPoints).toHaveLength(1);
    // Kept is one ordinary edit.
    store.getState().undo();
    expect(store.getState().document.openPoints).toHaveLength(0);
  });

  it('says so when the canvas holds as many open points as it can', () => {
    const notify = vi.spyOn(useUiStore.getState(), 'notify');
    try {
      const full = Array.from({ length: LIMITS.maxOpenPoints }, (_, index) => ({ id: `op-${index}`, kind: 'awaiting' as const, targets: [{ kind: 'node' as const, id: 'producer' }], context: `Point ${index}` }));
      store.getState().setDocument({ ...structuredClone(starter), openPoints: full });
      store.getState().takeDown('external');
      keepAsOpenPoint(replayQuestion());
      expect(store.getState().document.openPoints).toHaveLength(LIMITS.maxOpenPoints);
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(/as many open points as it can/), 'error');
    } finally {
      notify.mockRestore();
    }
  });

  it('never calls a canvas full when it only takes no edits just now', () => {
    const notify = vi.spyOn(useUiStore.getState(), 'notify');
    const locks = [
      { readOnly: { sharedTitle: 'Shared', collaborative: true as const } },
      { historyLens: true },
      { flowTrace: { documentId: 'd', path: [], revision: 0, title: 'Trace', edgeIds: [], choices: [], message: '' } },
    ];
    try {
      store.getState().takeDown('external');
      for (const lock of locks) {
        useUiStore.setState(lock);
        try {
          // The store refuses the point, as it refuses every edit while locked; nothing says the
          // canvas holds as many open points as it can, with none on it.
          keepAsOpenPoint(replayQuestion());
          expect(store.getState().document.openPoints).toHaveLength(0);
        } finally {
          useUiStore.setState({ readOnly: null, historyLens: false, flowTrace: null });
        }
      }
      expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/as many open points as it can/), 'error');
    } finally {
      notify.mockRestore();
    }
  });
});
