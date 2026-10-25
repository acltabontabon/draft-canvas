import { describe, expect, it } from 'vitest';
import { localAnswer, type LocalFacts } from '../../src/desktop/ui/nodiLocal';

/** What Nodi answers or does itself, with no agent run, and what it leaves to the agent. */

const facts: LocalFacts = {
  now: new Date(2026, 9, 23, 16, 5),
  title: 'Library',
  shapes: [
    { id: 'api', name: 'Library API', category: 'gateway' },
    { id: 'loans', name: 'Loan Manager', category: 'service' },
    { id: 'members', name: 'Member Manager', category: 'service' },
    { id: 'db', name: 'Library Database', category: 'database' },
    { id: 'q', name: 'notifications', category: 'queue' },
  ],
  connectors: [
    { id: 'r1', name: 'Check out' },
    { id: 'r2', name: 'Reads/writes loans' },
  ],
  flows: [{ id: 'f1', title: 'Borrow a book' }],
  boundaries: [],
  notes: 1,
  openPoints: 2,
  file: '~/Work/library.draftcanvas',
  folders: [
    { name: 'Work', displayPath: '~/Work', agent: true },
    { name: 'Private', displayPath: '~/Private', agent: false },
  ],
  agentName: 'Codex',
  commands: [
    { id: 'export', title: 'Export…', keywords: ['png', 'svg', 'pdf', 'image', 'download'] },
    { id: 'zoom-in', title: 'Zoom in' },
    { id: 'zoom-out', title: 'Zoom out' },
    { id: 'tidy-connectors', title: 'Tidy connectors', keywords: ['route', 'arrows'] },
    { id: 'present-flow', title: 'Present a flow…', keywords: ['presentation', 'slideshow'] },
    { id: 'settings', title: 'Canvas settings…' },
    { id: 'collaborate', title: 'Collaborate…', keywords: ['collaborate', 'live', 'invite', 'share', 'together', 'real time', 'multiplayer', 'session', 'people'] },
    { id: 'outline', title: 'Outline' },
    { id: 'fit', title: 'Fit to view' },
    { id: 'select-all', title: 'Select all' },
    { id: 'flow-new', title: 'New flow' },
    { id: 'back-out', title: 'Back out' },
    { id: 'companion', title: 'Nodi' },
  ],
};

describe('what Nodi answers itself', () => {
  it('tells the time from the clock', () => {
    for (const asked of ['what time is it?', 'What’s the time', 'time?', 'what day is it', 'whats the date']) {
      expect(localAnswer(asked, facts)?.text, asked).toMatch(/4:05|16:05/);
    }
  });

  it('counts and lists what is in the view, by name, as parts it can point at', () => {
    expect(localAnswer('how many services?', facts)?.text).toBe('2 services, boss:\n\n- [[loans]]\n- [[members]]');
    expect(localAnswer('list the queues', facts)?.text).toContain('[[q]]');
    expect(localAnswer('how many arrows are there', facts)?.text).toMatch(/^2 connectors/);
    expect(localAnswer('show me the caches', facts)?.text).toMatch(/No caches/);
    expect(localAnswer('what flows are there', facts)).toMatchObject({ actions: [{ kind: 'command', id: 'present-flow:f1' }] });
  });

  it('finds a part by name and brings it into view', () => {
    expect(localAnswer('where is the loan manager?', facts)).toMatchObject({ text: 'There, boss: [[loans]].', reveal: 'loans' });
    expect(localAnswer('find manager', facts)?.text).toContain('[[members]]');
    expect(localAnswer('where is the kafka cluster', facts)).toBeNull();
  });

  it('says where the file is and which folders agents can use', () => {
    expect(localAnswer('where is this file saved?', facts)?.text).toContain('~/Work/library.draftcanvas');
    const folders = localAnswer('which folders can you access?', facts);
    expect(folders?.text).toContain('Work');
    expect(folders?.text).not.toContain('Private');
  });

  it('sums the diagram up, and offers the agent for what it means', () => {
    const summary = localAnswer('what’s in this diagram?', facts);
    expect(summary?.text).toMatch(/5 parts \(2 services, .*1 gateway.*\), 2 connectors, 1 flow, 2 open points/);
    expect(summary?.actions?.[0]).toMatchObject({ kind: 'ask', prompt: 'Explain this diagram' });
  });

  it('says what it can do, with buttons', () => {
    const help = localAnswer('What can you do?', facts)!;
    expect(help.text).toMatch(/Codex/);
    expect(help.actions!.map((a) => a.label)).toEqual(['Walk me through it', 'What breaks first?', 'Export…', 'Present Borrow a book', 'Every command']);
  });

  it('says what it can’t do, honestly', () => {
    const limits = localAnswer('what can’t you do?', facts)!;
    expect(limits.text).toMatch(/code or your files/);
    expect(limits.text).toMatch(/make you rich/);
  });

  it('runs the app’s own command it was plainly asked for, never Nodi itself', () => {
    /** The command Nodi runs at once, or the first it offers. */
    const did = (asked: string) => {
      const answer = localAnswer(asked, facts);
      const offered = answer?.actions?.[0];
      return answer?.run ?? (offered?.kind === 'command' ? offered.id : undefined);
    };
    expect(localAnswer('export', facts)).toMatchObject({ run: 'export' });
    expect(localAnswer('export', facts)?.actions).toBeUndefined();
    for (const [asked, id] of [
      ['export as png please', 'export'],
      ['zoom in', 'zoom-in'],
      ['can you tidy the connectors', 'tidy-connectors'],
      // Said the way people say it: another form of the word, and a verb that only says "do it".
      ['can you start a collaboration session', 'collaborate'],
      ['start a live session', 'collaborate'],
      ['invite people', 'collaborate'],
      ['open the outline', 'outline'],
      ['exporting to png', 'export'],
      // Everyday words for what a command calls something.
      ['download as png', 'export'],
      ['save as png', 'export'],
      ['fit to screen', 'fit'],
      ['select everything', 'select-all'],
      ['make a new flow', 'flow-new'],
      ['clean up the arrows', 'tidy-connectors'],
    ] as const) {
      expect(did(asked), asked).toBe(id);
    }
    expect(localAnswer('dark mode', facts)?.actions?.[0]).toMatchObject({ id: 'settings' });
    // Not sure which: offered, not run. "Zoom" alone is in or out.
    expect(localAnswer('zoom', facts)).toMatchObject({ actions: [{ id: 'zoom-in' }, { id: 'zoom-out' }] });
    expect(localAnswer('zoom', facts)?.run).toBeUndefined();
    // "Outline" is not "Back out", and a bare "save" is the file's own.
    expect(localAnswer('open the outline', facts)?.run).toBe('outline');
    expect(localAnswer('save', facts)).toBeNull();
  });

  it('never ends a live session straight from a sentence', () => {
    const live = { ...facts, commands: [...facts.commands, { id: 'end-session', title: 'End live session', keywords: ['stop', 'collaborate', 'live', 'disconnect'] }] };
    const answer = localAnswer('end the live session', live);
    expect(answer?.run).toBeUndefined();
    expect(answer?.actions?.[0]).toMatchObject({ id: 'end-session' });
  });

  it('leaves to the agent anything that is about the architecture', () => {
    for (const asked of ['add a cache in front of the database', 'what breaks first?', 'export the design doc for the cache', 'why is the queue there', 'explain the loan flow', 'show me how a book is borrowed', 'zoom in on the risks of this design please']) {
      expect(localAnswer(asked, facts), asked).toBeNull();
    }
  });

  it('never mistakes a generic follow-up for an architecture starter', () => {
    const starters = { ...facts, commands: [...facts.commands, { id: 'starter-change-data-capture', title: 'Change Data Capture', keywords: ['cdc', 'debezium'] }] };
    for (const asked of ['do it change it', 'do the change', 'make the change', 'show change', 'do data']) {
      expect(localAnswer(asked, starters), asked).toBeNull();
    }
    expect(localAnswer('start change data capture', starters)?.run).toBe('starter-change-data-capture');
    expect(localAnswer('start cdc', starters)?.run).toBe('starter-change-data-capture');
  });

  it('offers editing commands for capability questions without executing them', () => {
    const editing = { ...facts, commands: [...facts.commands, { id: 'undo', title: 'Undo' }, { id: 'delete', title: 'Delete' }, { id: 'cut', title: 'Cut' }] };
    for (const [asked, id] of [['can I undo?', 'undo'], ['could I delete that?', 'delete'], ['please could I cut?', 'cut'], ['hey Nodi, can I undo that?', 'undo']] as const) {
      const answer = localAnswer(asked, editing);
      expect(answer?.run, asked).toBeUndefined();
      expect(answer?.actions, asked).toContainEqual({ kind: 'command', id, label: editing.commands.find((c) => c.id === id)!.title });
    }
    expect(localAnswer('can you undo?', editing)?.run).toBe('undo');
    expect(localAnswer('could you delete that?', editing)?.run).toBe('delete');
  });
});
