import { beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/desktop/api';
import { applyRunEvent, companion, newTokens, newTurn, numberedBlocks, partsIn, replyBlocks, replyOf, replyPoints, spentOn, stepText, stopMessage, tokenCount } from '../../src/desktop/companion';
import { frame, HEIGHT, ROWS, WIDTH } from '../../src/desktop/ui/mascot/pixels';
import { createHarness } from './harness';

/**
 * The companion's conversations: a run's events folded into its turn, runs a reloaded page finds, and
 * the controller between the shell and the store.
 */

const RUN = '3f1c2a4e-0000-4000-8000-000000000001';

const TURN: RunEvent[] = [
  { type: 'started', session: 's-1' },
  { type: 'tool-call', id: 't1', tool: 'read_diagram', status: 'in-progress' },
  { type: 'tool-call-update', id: 't1', status: 'completed', error: null },
  { type: 'tool-call', id: 't2', tool: 'submit_proposal', status: 'in-progress' },
  { type: 'message-chunk', text: 'I proposed ' },
  { type: 'message-chunk', text: 'a cache.' },
  // A real turn's shape: nearly all of it the agent reading its instructions and the diagram in.
  { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'I proposed a cache.', costMicroUsd: 41200, usage: { input: 60_953, cached: 30_392, output: 114 } },
];

beforeEach(() => {
  companion.__reset();
});

describe('a turn', () => {
  it('collects the steps, the streamed reply and how it stopped', () => {
    const turn = TURN.reduce(applyRunEvent, newTurn(RUN, 'Add a cache', 'Orders database'));
    expect(turn.steps.map((s) => [s.tool, s.status])).toEqual([
      ['read_diagram', 'completed'],
      // Left open when the run stopped: it didn't finish.
      ['submit_proposal', 'failed'],
    ]);
    expect(replyOf(turn)).toBe('I proposed a cache.');
    expect(turn.stop).toEqual({ kind: 'end-turn' });
    expect(turn.costMicroUsd).toBe(41200);
  });

  it('ignores anything after it stopped, and a repeated tool call', () => {
    const stopped = applyRunEvent(newTurn(RUN, 'x', null), { type: 'stopped', reason: { kind: 'cancelled' }, summary: null, costMicroUsd: null, usage: null });
    expect(applyRunEvent(stopped, { type: 'message-chunk', text: 'late' })).toBe(stopped);
    const once = applyRunEvent(newTurn(RUN, 'x', null), { type: 'tool-call', id: 't', tool: 'read_diagram', status: 'in-progress' });
    expect(applyRunEvent(once, { type: 'tool-call', id: 't', tool: 'read_diagram', status: 'in-progress' })).toBe(once);
  });

  it('falls back to the summary, and words every way it can end', () => {
    const quiet = applyRunEvent(newTurn(RUN, 'x', null), { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'Done.', costMicroUsd: null, usage: null });
    expect(replyOf(quiet)).toBe('Done.');
    expect(stopMessage({ kind: 'end-turn' })).toBeNull();
    expect(stopMessage({ kind: 'cancelled' })).toBe('Stopped.');
    expect(stopMessage({ kind: 'failed', message: 'Not signed in' })).toBe('Not signed in');
    expect(stopMessage({ kind: 'max-turns' })).toMatch(/ran out of steps/);
    expect(stepText('read_diagram')).toBe('Reading the diagram');
    expect(stepText('something_new')).toBe('something_new');
  });
});

describe('a reply', () => {
  it('reads as paragraphs and lists, the way advice is written', () => {
    const text = [
      'Caching would take reads off the database.',
      '',
      'Options:',
      '- Cache-aside: the worker reads the cache first',
      '  and fills it on a miss',
      '* Read replicas',
      '',
      '1. How read-heavy is it?',
      '2) How fresh must orders be?',
    ].join('\n');
    expect(replyBlocks(text)).toEqual([
      { kind: 'p', text: 'Caching would take reads off the database.' },
      { kind: 'p', text: 'Options:' },
      { kind: 'ul', items: ['Cache-aside: the worker reads the cache first and fills it on a miss', 'Read replicas'] },
      { kind: 'ol', items: ['How read-heavy is it?', 'How fresh must orders be?'] },
    ]);
  });
});

describe('a reply that points at the diagram', () => {
  const text = [
    'The main risks:',
    '',
    '- **Dual write on publish.** [[svc]] saves, then publishes over [[r_pub]]: two writes.',
    '- Duplicate postings at [[ledger]], and again at [[ledger]] on replay.',
    '- A part of another view, [[elsewhere]].',
    '',
    'Both start at [[svc]].',
  ].join('\n');
  const known = (id: string) => ['svc', 'r_pub', 'ledger'].includes(id);

  it('names each part once, in order', () => {
    expect(partsIn('[[a]] then [[b]] then [[a]]; [[not an id]] and [[]] are not parts')).toEqual(['a', 'b']);
  });

  it('numbers each paragraph or bullet that names a part of the view, and only those', () => {
    const blocks = numberedBlocks(replyBlocks(text), known);
    expect(replyPoints(blocks)).toEqual([
      { point: 1, parts: ['svc', 'r_pub'] },
      { point: 2, parts: ['ledger'] },
      { point: 3, parts: ['svc'] },
    ]);
    // The heading and the bullet about another view's part stay unnumbered.
    const list = blocks[1] as { entries: { point: number | null }[] };
    expect(list.entries.map((e) => e.point)).toEqual([1, 2, null]);
    expect(blocks[0]).toMatchObject({ kind: 'p', entry: { point: null } });
  });
});

describe('the store', () => {
  it('keeps conversations by diagram and says which run is still working', () => {
    companion.begin('d_1', RUN, 'Add a cache', null);
    expect(companion.running('d_1')?.runId).toBe(RUN);
    for (const event of TURN) companion.apply(RUN, event);
    expect(companion.running('d_1')).toBeNull();
    expect(companion.snapshot().get('d_1')?.turns).toHaveLength(1);
    companion.apply('unknown-run', { type: 'message-chunk', text: 'x' });
    expect(companion.snapshot().get('d_1')?.turns[0]?.reply).toBe('I proposed a cache.');
  });

  it('rebuilds a run a reloaded page finds, once', () => {
    const snapshot = { runId: RUN, diagramId: 'd_1', agent: 'claude-code' as const, prompt: 'Add a cache', events: TURN.slice(0, 3) };
    companion.restore([snapshot]);
    companion.restore([snapshot]);
    const turns = companion.snapshot().get('d_1')!.turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ prompt: 'Add a cache', stop: null });
    expect(turns[0]!.steps).toHaveLength(1);
  });

  it('a new conversation drops finished turns but keeps one still working', () => {
    companion.begin('d_1', 'done', 'First', null);
    companion.apply('done', { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null });
    companion.begin('d_1', RUN, 'Second', null);
    companion.clear('d_1');
    expect(companion.snapshot().get('d_1')!.turns.map((t) => t.prompt)).toEqual(['Second']);
    companion.apply(RUN, { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null });
    companion.clear('d_1');
    expect(companion.snapshot().has('d_1')).toBe(false);
  });
});

describe('what a conversation uses', () => {
  const stop = (usage: { input: number; cached: number; output: number } | null, costMicroUsd: number | null = null): RunEvent => ({ type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd, usage });

  it('adds every turn that said, and leaves out one that didn’t', () => {
    companion.begin('d_1', 'a', 'First', null);
    companion.apply('a', stop({ input: 48_000, cached: 0, output: 200 }, 190_000));
    companion.begin('d_1', 'b', 'Second', null);
    companion.apply('b', stop(null));
    companion.begin('d_1', 'c', 'Third', null);
    companion.apply('c', stop({ input: 50_000, cached: 46_000, output: 300 }, 30_000));
    expect(spentOn(companion.snapshot().get('d_1'))).toEqual({ usage: { input: 98_000, cached: 46_000, output: 500 }, costMicroUsd: 220_000, turns: 2 });
  });

  it('keeps counting turns the conversation no longer keeps, and starts over with a new one', () => {
    for (let i = 0; i < 25; i += 1) {
      companion.begin('d_1', `r${i}`, `Turn ${i}`, null);
      companion.apply(`r${i}`, stop({ input: 1000, cached: 500, output: 10 }));
    }
    const conversation = companion.snapshot().get('d_1')!;
    expect(conversation.turns).toHaveLength(20);
    expect(spentOn(conversation)).toMatchObject({ usage: { input: 25_000, cached: 12_500, output: 250 }, turns: 25 });
    companion.clear('d_1');
    expect(spentOn(companion.snapshot().get('d_1'))).toBeNull();
  });

  it('is nothing until a turn reports it', () => {
    companion.begin('d_1', RUN, 'Add a cache', null);
    expect(spentOn(companion.snapshot().get('d_1'))).toBeNull();
    expect(spentOn(undefined)).toBeNull();
  });

  it('reads at a glance', () => {
    expect([640, 4_800, 4_000, 48_169, 999_999, 1_200_000, 3_000_000].map(tokenCount)).toEqual(['640', '4.8k', '4k', '48k', '1M', '1.2M', '3M']);
    // What the turn added leads; the cached repeat of its context follows.
    expect(newTokens({ input: 507_000, cached: 494_000, output: 1_000 })).toBe(14_000);
  });
});

describe('the controller', () => {
  it('sends a prompt, folds the shell’s events in, and finds the turn’s proposal', async () => {
    const h = createHarness();
    await h.controller.start();
    h.agent.proposals.set('p1', { proposalId: 'p1', diagramId: 'd_1', status: 'pending', run: RUN } as never);
    await h.controller.companionSend(
      { runId: RUN, diagramId: 'd_1', text: 'Add a cache', selection: null, room: [], agent: 'claude-code', mode: 'proposal' },
      null,
    );
    expect(h.agent.companion.sent).toHaveLength(1);
    for (const event of TURN) h.hostEvent({ type: 'companion', run: RUN, event });
    await h.settle();
    const turn = companion.snapshot().get('d_1')!.turns[0]!;
    expect(turn.stop).toEqual({ kind: 'end-turn' });
    expect(turn.proposalId).toBe('p1');

    h.agent.proposals.set('p1', { proposalId: 'p1', diagramId: 'd_1', status: 'accepted', run: RUN } as never);
    h.hostEvent({ type: 'agent-changed' });
    await h.settle();
    expect(companion.snapshot().get('d_1')!.turns[0]!.proposalId).toBeNull();
  });

  it('ends the turn with the shell’s own words when it refuses to start', async () => {
    const h = createHarness();
    await h.controller.start();
    h.agent.companion.refuse = 'Turn on agent access in Settings → AI agents first.';
    await h.controller.companionSend(
      { runId: RUN, diagramId: 'd_1', text: 'Add a cache', selection: null, room: [], agent: 'claude-code', mode: 'proposal' },
      null,
    );
    const turn = companion.snapshot().get('d_1')!.turns[0]!;
    expect(stopMessage(turn.stop)).toBe('Turn on agent access in Settings → AI agents first.');
  });

  it('tells every proposal list when one is resolved, so a badge never keeps an accepted proposal', async () => {
    const h = createHarness();
    await h.controller.start();
    h.agent.proposals.set('p1', { proposalId: 'p1', diagramId: 'd_1', status: 'accepting', run: RUN } as never);
    let heard = 0;
    h.controller.onProposalsChanged(() => (heard += 1));
    await h.controller.resolveProposal('p1', 'accepted');
    expect(heard).toBe(1);
  });

  it('knows agent access is on from the start, without Settings having been opened', async () => {
    const h = createHarness();
    h.agent.settings.enabled = true;
    h.agent.settings.listening = true;
    await h.controller.start();
    expect(h.store.getSnapshot().agent).toMatchObject({ enabled: true });
  });

  it('picks up runs still going when the page starts', async () => {
    const h = createHarness();
    h.agent.companion.runs = [{ runId: RUN, diagramId: 'd_1', agent: 'claude-code', prompt: 'Add a cache', events: TURN.slice(0, 2) }];
    await h.controller.start();
    expect(companion.running('d_1')?.prompt).toBe('Add a cache');
  });

  it('forgets a conversation in the store and the shell', async () => {
    const h = createHarness();
    await h.controller.start();
    companion.begin('d_1', 'done', 'First', null);
    companion.apply('done', { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null });
    await h.controller.companionForget('d_1');
    expect(companion.snapshot().has('d_1')).toBe(false);
    expect(h.agent.companion.forgotten).toEqual(['d_1']);
  });
});

describe('the mascot', () => {
  it('draws every frame inside its box, with a shadow on the ground', () => {
    expect(ROWS.every((row) => row.length === WIDTH)).toBe(true);
    for (const mood of ['idle', 'working', 'waiting', 'happy', 'asleep', 'walking', 'angry', 'dizzy', 'love', 'surprised', 'sleepy'] as const) {
      for (let tick = 0; tick < 32; tick += 1) {
        const runs = frame(mood, tick);
        expect(runs.every((r) => r.x >= 0 && r.x + r.width <= WIDTH && r.y >= 0 && r.y < HEIGHT)).toBe(true);
        expect(runs.at(-1)!.y).toBe(HEIGHT - 1);
      }
    }
  });

  it('shows how it feels in its face: red when cross, pink when pleased, a Z when it dozes', () => {
    const fills = (mood: Parameters<typeof frame>[0]) => new Set(frame(mood, 0).map((r) => r.fill));
    expect(fills('angry').has('#ff7a66')).toBe(true);
    expect(fills('love').has('#ff9ec7')).toBe(true);
    expect(fills('idle').has('#ff7a66')).toBe(false);
    // Shaking: the same frame drawn a pixel apart from one tick to the next.
    expect(frame('angry', 0)[0]!.x - frame('angry', 1)[0]!.x).toBe(2);
    // The Z beside the head, above where the head starts.
    expect(frame('sleepy', 0).some((r) => r.x >= 19 && r.y < 2)).toBe(true);
  });
});
