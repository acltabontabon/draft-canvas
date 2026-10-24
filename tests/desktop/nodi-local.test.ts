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

  it('offers the app’s own commands as buttons, never Nodi itself', () => {
    expect(localAnswer('export', facts)?.actions).toEqual([{ kind: 'command', id: 'export', label: 'Export…' }]);
    expect(localAnswer('export as png please', facts)?.actions?.[0]).toMatchObject({ id: 'export' });
    expect(localAnswer('zoom in', facts)?.actions?.[0]).toMatchObject({ id: 'zoom-in' });
    expect(localAnswer('can you tidy the connectors', facts)?.actions?.[0]).toMatchObject({ id: 'tidy-connectors' });
    expect(localAnswer('dark mode', facts)?.actions?.[0]).toMatchObject({ id: 'settings' });
  });

  it('leaves to the agent anything that is about the architecture', () => {
    for (const asked of ['add a cache in front of the database', 'what breaks first?', 'export the design doc for the cache', 'why is the queue there', 'explain the loan flow', 'show me how a book is borrowed', 'zoom in on the risks of this design please']) {
      expect(localAnswer(asked, facts), asked).toBeNull();
    }
  });
});
