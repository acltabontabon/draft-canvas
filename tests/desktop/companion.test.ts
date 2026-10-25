import { beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent, RunSnapshot } from '../../src/desktop/api';
import { activityOf, applyRunEvent, companion, conversationKey, newTokens, newTurn, numberedBlocks, partsIn, replyBlocks, replyOf, replyPoints, spentOn, stepText, stopMessage, tokenCount } from '../../src/desktop/companion';
import { CHANNEL_MS, CHANNEL_TICKS, CHANNELS, channelAt, channelClock, channelFrame, frame, HEIGHT, ROWS, WIDTH } from '../../src/desktop/ui/mascot/pixels';
import { unchangedSinceLastTurn } from '../../src/desktop/turnSnapshot';
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
    expect(companion.snapshot().get(conversationKey('d_1'))?.turns).toHaveLength(1);
    companion.apply('unknown-run', { type: 'message-chunk', text: 'x' });
    expect(companion.snapshot().get(conversationKey('d_1'))?.turns[0]?.reply).toBe('I proposed a cache.');
  });

  it('rebuilds a run a reloaded page finds, once', () => {
    const snapshot = { runId: RUN, diagramId: 'd_1', agent: 'claude-code' as const, prompt: 'Add a cache', events: TURN.slice(0, 3) };
    companion.restore([snapshot]);
    companion.restore([snapshot]);
    const turns = companion.snapshot().get(conversationKey('d_1'))!.turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ prompt: 'Add a cache', stop: null });
    expect(turns[0]!.steps).toHaveLength(1);
    expect(companion.snapshot().get(conversationKey('d_1'))!.agent).toBe('claude-code');
  });

  it('bounds older recovered turns without changing the latest page turn’s agent', () => {
    for (let i = 0; i < 20; i += 1) {
      companion.begin('d_1', `old-${i}`, 'Earlier', null, 'claude-code');
      companion.apply(`old-${i}`, TURN.at(-1)!);
    }
    companion.restore([
      { runId: 'finished', diagramId: 'd_1', agent: 'codex', prompt: 'Finished', sequence: 1, events: [TURN.at(-1)!] },
      { runId: 'finished-2', diagramId: 'd_1', agent: 'codex', prompt: 'Also finished', sequence: 1, events: [TURN.at(-1)!] },
    ]);
    const restored = companion.snapshot().get(conversationKey('d_1'))!;
    expect(restored.turns).toHaveLength(20);
    expect(restored.earlier).toBeUndefined();
    expect(companion.snapshot().get(conversationKey('d_1', 'codex'))?.turns.map((turn) => turn.runId)).toEqual(['finished', 'finished-2']);
    expect(restored.agent).toBe('claude-code');
    expect(restored.turns.at(-1)!.runId).toBe('old-19');
    expect(companion.running('d_1')).toBeNull();
  });

  it('isolates each agent history, local replies, proposals and clearing while events keep their owner', () => {
    companion.begin('d_1', 'claude', 'Could you rearrange it?', null, 'claude-code');
    companion.apply('claude', { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'Do you want a row?', costMicroUsd: null, usage: null });
    companion.setProposal('claude', 'claude-proposal');
    companion.begin('d_1', 'codex', 'Explain this', null, 'codex');
    companion.apply('codex', { type: 'stopped', reason: { kind: 'end-turn' }, summary: 'Codex reply', costMicroUsd: null, usage: null });
    companion.selectAgent('d_1', 'codex');
    expect(companion.selected('d_1')?.turns.map((turn) => turn.runId)).toEqual(['codex']);
    companion.answer('d_1', 'Thanks', 'Welcome', undefined, 'codex');
    companion.selectAgent('d_1', 'claude-code');
    expect(companion.selected('d_1')?.turns[0]?.summary).toBe('Do you want a row?');
    expect(companion.selected('d_1')?.turns[0]?.proposalId).toBe('claude-proposal');
    expect(companion.diagramOf('codex')).toBe('d_1');
    companion.clear('d_1', 'codex');
    expect(companion.snapshot().has(conversationKey('d_1', 'codex'))).toBe(false);
    expect(companion.selected('d_1')?.turns).toHaveLength(1);
    companion.resolve('claude', 'accepted');
    expect(companion.selected('d_1')?.turns[0]?.outcome).toBe('accepted');
  });

  it('evicts finished conversations while keeping an active run', () => {
    companion.begin('working', 'working', 'Still going', null);
    const view = { nodes: [], edges: [], flows: [] };
    unchangedSinceLastTurn('old', view, [], 'codex', false);
    companion.answer('old', 'Hello', 'Hello');
    for (let i = 0; i < 105; i += 1) companion.answer(`diagram-${i}`, 'Hi', 'Hi');
    expect(companion.snapshot().size).toBe(100);
    expect(companion.running('working')?.runId).toBe('working');
    expect(companion.snapshot().has(conversationKey('old'))).toBe(false);
    expect(unchangedSinceLastTurn('old', view, [], 'codex', true)).toBe(false);
  });

  it('a new conversation drops finished turns but keeps one still working', () => {
    companion.begin('d_1', 'done', 'First', null);
    companion.apply('done', { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null });
    companion.begin('d_1', RUN, 'Second', null);
    companion.clear('d_1');
    expect(companion.snapshot().get(conversationKey('d_1'))!.turns.map((t) => t.prompt)).toEqual(['Second']);
    companion.apply(RUN, { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null });
    companion.clear('d_1');
    expect(companion.snapshot().has(conversationKey('d_1'))).toBe(false);
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
    expect(spentOn(companion.snapshot().get(conversationKey('d_1')))).toEqual({ usage: { input: 98_000, cached: 46_000, output: 500 }, costMicroUsd: 220_000, turns: 2 });
  });

  it('keeps counting turns the conversation no longer keeps, and starts over with a new one', () => {
    for (let i = 0; i < 25; i += 1) {
      companion.begin('d_1', `r${i}`, `Turn ${i}`, null);
      companion.apply(`r${i}`, stop({ input: 1000, cached: 500, output: 10 }));
    }
    const conversation = companion.snapshot().get(conversationKey('d_1'))!;
    expect(conversation.turns).toHaveLength(20);
    expect(spentOn(conversation)).toMatchObject({ usage: { input: 25_000, cached: 12_500, output: 250 }, turns: 25 });
    companion.clear('d_1');
    expect(spentOn(companion.snapshot().get(conversationKey('d_1')))).toBeNull();
  });

  it('clears earlier usage even when a running turn must be kept', () => {
    for (let i = 0; i < 21; i += 1) {
      companion.begin('d_1', `r${i}`, 'Hello', null);
      companion.apply(`r${i}`, stop({ input: 100, cached: 0, output: 1 }));
    }
    companion.begin('d_1', 'active', 'Keep this turn', null);
    companion.clear('d_1');
    expect(companion.running('d_1')?.runId).toBe('active');
    expect(spentOn(companion.snapshot().get(conversationKey('d_1')))).toBeNull();
  });

  it('is nothing until a turn reports it', () => {
    companion.begin('d_1', RUN, 'Add a cache', null);
    expect(spentOn(companion.snapshot().get(conversationKey('d_1')))).toBeNull();
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
    const turn = companion.snapshot().get(conversationKey('d_1'))!.turns[0]!;
    expect(turn.stop).toEqual({ kind: 'end-turn' });
    expect(turn.proposalId).toBe('p1');

    h.agent.proposals.set('p1', { proposalId: 'p1', diagramId: 'd_1', status: 'accepted', run: RUN } as never);
    h.hostEvent({ type: 'agent-changed' });
    await h.settle();
    expect(companion.snapshot().get(conversationKey('d_1'))!.turns[0]!.proposalId).toBeNull();
  });

  it('tracks pending proposals from both agent histories on the same diagram', async () => {
    const h = createHarness();
    await h.controller.start();
    for (const [runId, agent] of [['claude', 'claude-code'], ['codex', 'codex']] as const) {
      companion.begin('d_1', runId, 'Rearrange it', null, agent);
      companion.apply(runId, { type: 'tool-call', id: `tool-${runId}`, tool: 'submit_proposal', status: 'completed' });
      companion.apply(runId, TURN.at(-1)!);
      h.agent.proposals.set(`p-${runId}`, { proposalId: `p-${runId}`, diagramId: 'd_1', status: 'pending', run: runId } as never);
    }
    await h.controller.refreshCompanionProposals();
    expect(companion.snapshot().get(conversationKey('d_1', 'claude-code'))?.turns[0]?.proposalId).toBe('p-claude');
    expect(companion.snapshot().get(conversationKey('d_1', 'codex'))?.turns[0]?.proposalId).toBe('p-codex');
    await h.controller.companionForget('d_1', 'codex');
    expect(h.api.companionForget).toHaveBeenLastCalledWith('d_1', 'codex');
    expect(companion.snapshot().has(conversationKey('d_1', 'claude-code'))).toBe(true);
    expect(companion.snapshot().has(conversationKey('d_1', 'codex'))).toBe(false);
  });

  it('ends the turn with the shell’s own words when it refuses to start', async () => {
    const h = createHarness();
    await h.controller.start();
    h.agent.companion.refuse = 'Turn on agent access in Settings → AI agents first.';
    const view = { nodes: [], edges: [], flows: [] };
    unchangedSinceLastTurn('d_1', view, [], 'claude-code', false);
    await h.controller.companionSend(
      { runId: RUN, diagramId: 'd_1', text: 'Add a cache', selection: null, room: [], agent: 'claude-code', mode: 'proposal' },
      null,
    );
    const turn = companion.snapshot().get(conversationKey('d_1'))!.turns[0]!;
    expect(stopMessage(turn.stop)).toBe('Turn on agent access in Settings → AI agents first.');
    expect(unchangedSinceLastTurn('d_1', view, [], 'claude-code', true)).toBe(false);
  });

  it('sends the view again after a Stop that may have arrived before the agent read it', async () => {
    const h = createHarness();
    await h.controller.start();
    const view = { nodes: [], edges: [], flows: [] };
    unchangedSinceLastTurn('d_cancelled', view, [], 'claude-code', false);
    await h.controller.companionSend(
      { runId: RUN, diagramId: 'd_cancelled', text: 'Explain', selection: null, room: [], agent: 'claude-code', mode: 'proposal' },
      null,
    );
    await h.controller.companionCancel(RUN);
    expect(h.agent.companion.cancelled).toEqual([RUN]);
    expect(unchangedSinceLastTurn('d_cancelled', view, [], 'claude-code', true)).toBe(false);
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

  it('replays events after a recovery snapshot exactly once, including a terminal event', async () => {
    const h = createHarness();
    let recovered!: (runs: RunSnapshot[]) => void;
    h.api.companionRuns.mockImplementation(() => new Promise((resolve) => (recovered = resolve)));
    const starting = h.controller.start();
    await h.settle();
    h.hostEvent({ type: 'companion', run: RUN, sequence: 2, event: { type: 'message-chunk', text: 'Already in the snapshot. ' } });
    h.hostEvent({ type: 'companion', run: RUN, sequence: 4, event: TURN.at(-1)! });
    h.hostEvent({ type: 'companion', run: RUN, sequence: 3, event: { type: 'message-chunk', text: 'Arrived later.' } });
    recovered([{ runId: RUN, diagramId: 'd_1', agent: 'codex', prompt: 'Explain it', sequence: 2, events: [TURN[0]!, { type: 'message-chunk', text: 'Already in the snapshot. ' }] }]);
    await starting;
    const turn = companion.snapshot().get(conversationKey('d_1', 'codex'))!.turns[0]!;
    expect(turn.reply).toBe('Already in the snapshot. Arrived later.');
    expect(turn.stop).toEqual({ kind: 'end-turn' });
    expect(companion.snapshot().get(conversationKey('d_1', 'codex'))!.agent).toBe('codex');
    expect(companion.running('d_1')).toBeNull();
    h.hostEvent({ type: 'companion', run: RUN, sequence: 3, event: { type: 'message-chunk', text: 'Duplicate' } });
    expect(companion.snapshot().get(conversationKey('d_1', 'codex'))!.turns[0]!.reply).toBe(turn.reply);
  });

  it('keeps buffered events for a turn begun by this page while recovery was pending', async () => {
    const h = createHarness();
    let recovered!: (runs: RunSnapshot[]) => void;
    h.api.companionRuns.mockImplementation(() => new Promise((resolve) => (recovered = resolve)));
    const starting = h.controller.start();
    await h.settle();
    companion.begin('d_1', RUN, 'New turn', null);
    h.hostEvent({ type: 'companion', run: RUN, sequence: 1, event: { type: 'message-chunk', text: 'Keep me' } });
    recovered([{ runId: RUN, diagramId: 'd_1', agent: 'codex', prompt: 'New turn', sequence: 1, events: [{ type: 'message-chunk', text: 'Keep me' }] }]);
    await starting;
    expect(companion.snapshot().get(conversationKey('d_1'))!.turns[0]!.reply).toBe('Keep me');
  });

  it('places older recovered turns before a newer turn begun by this page', async () => {
    const h = createHarness();
    let recovered!: (runs: RunSnapshot[]) => void;
    h.api.companionRuns.mockImplementation(() => new Promise((resolve) => (recovered = resolve)));
    const starting = h.controller.start();
    await h.settle();
    companion.begin('d_1', 'new-page-run', 'Newest question', null, 'claude-code');
    h.hostEvent({ type: 'companion', run: 'new-page-run', sequence: 1, event: { type: 'message-chunk', text: 'Newest reply' } });
    recovered([
      { runId: 'older-a', diagramId: 'd_1', agent: 'codex', prompt: 'Older A', sequence: 1, events: [TURN.at(-1)!] },
      { runId: 'older-b', diagramId: 'd_1', agent: 'codex', prompt: 'Older B', sequence: 1, events: [TURN.at(-1)!] },
    ]);
    await starting;
    const conversation = companion.snapshot().get(conversationKey('d_1'))!;
    expect(conversation.turns.map((turn) => turn.runId)).toEqual(['new-page-run']);
    expect(companion.snapshot().get(conversationKey('d_1', 'codex'))?.turns.map((turn) => turn.runId)).toEqual(['older-a', 'older-b']);
    expect(conversation.agent).toBe('claude-code');
    expect(conversation.turns.at(-1)!.reply).toBe('Newest reply');
    expect(companion.running('d_1')?.runId).toBe('new-page-run');
  });

  it('restores a run that finished before the native recovery snapshot was captured', async () => {
    const h = createHarness();
    let recovered!: (runs: RunSnapshot[]) => void;
    h.api.companionRuns.mockImplementation(() => new Promise((resolve) => (recovered = resolve)));
    const starting = h.controller.start();
    await h.settle();
    const final = TURN.at(-1)!;
    h.hostEvent({ type: 'companion', run: RUN, sequence: 3, event: final });
    recovered([{ runId: RUN, diagramId: 'd_1', agent: 'codex', prompt: 'Explain it', sequence: 3, events: [TURN[0]!, { type: 'message-chunk', text: 'Finished before capture.' }, final] }]);
    await starting;
    const restored = companion.snapshot().get(conversationKey('d_1', 'codex'))!.turns[0]!;
    expect(restored.reply).toBe('Finished before capture.');
    expect(restored.stop).toEqual({ kind: 'end-turn' });
    expect(companion.running('d_1')).toBeNull();
  });

  it('bounds recovery events and cancels the affected turn if the window cannot catch up', async () => {
    const h = createHarness();
    let recovered!: (runs: RunSnapshot[]) => void;
    h.api.companionRuns.mockImplementation(() => new Promise((resolve) => (recovered = resolve)));
    const starting = h.controller.start();
    await h.settle();
    for (let sequence = 1; sequence <= 4100; sequence += 1) h.hostEvent({ type: 'companion', run: RUN, sequence, event: { type: 'message-chunk', text: 'x' } });
    recovered([{ runId: RUN, diagramId: 'd_1', agent: 'codex', prompt: 'Too much', sequence: 0, events: [] }]);
    await starting;
    expect(companion.running('d_1')).toBeNull();
    expect(companion.snapshot().get(conversationKey('d_1', 'codex'))!.turns[0]!.stop).toMatchObject({ kind: 'failed', message: expect.stringContaining('recovering') });
    expect(h.agent.companion.cancelled).toContain(RUN);
  });

  it('reads the view afresh after an agent fails before consuming the prompt', async () => {
    const h = createHarness();
    await h.controller.start();
    const view = { nodes: [], edges: [], flows: [] };
    unchangedSinceLastTurn('d_1', view, [], 'codex', false);
    companion.begin('d_1', RUN, 'Explain it', null, 'codex');
    h.hostEvent({ type: 'companion', run: RUN, sequence: 1, event: { type: 'stopped', reason: { kind: 'failed', message: 'Sign in first' }, summary: null, costMicroUsd: null, usage: null } });
    expect(unchangedSinceLastTurn('d_1', view, [], 'codex', true)).toBe(false);
  });

  it('forgets a conversation in the store and the shell', async () => {
    const h = createHarness();
    await h.controller.start();
    companion.begin('d_1', 'done', 'First', null);
    companion.apply('done', { type: 'stopped', reason: { kind: 'end-turn' }, summary: null, costMicroUsd: null, usage: null });
    await h.controller.companionForget('d_1');
    expect(companion.snapshot().has(conversationKey('d_1'))).toBe(false);
    expect(h.agent.companion.forgotten).toEqual(['d_1']);
  });
});

describe('what a turn did, in one line', () => {
  const step = (id: string, tool: string, status: 'in-progress' | 'completed' | 'failed', error: string | null = null) => ({ id, tool, status, error });

  it('says the step under way while it runs, and each kind of thing it did once when over', () => {
    const steps = [step('1', 'get_capabilities', 'completed'), step('2', 'read_diagram', 'completed'), step('3', 'read_diagram', 'completed'), step('4', 'read_diagram', 'in-progress')];
    expect(activityOf(steps, true)).toEqual({ now: 'Reading the diagram', done: ['Read the diagram'], snag: null });
    const over = [...steps.slice(0, 3), step('4', 'read_diagram', 'completed'), step('5', 'submit_proposal', 'completed')];
    expect(activityOf(over, false)).toEqual({ now: null, done: ['Read the diagram', 'Proposed a change'], snag: null });
  });

  it('keeps quiet about a failed step the agent put right, and says one it never did', () => {
    const retried = [step('1', 'read_diagram', 'failed', '/scope: unknown field'), step('2', 'read_diagram', 'completed')];
    expect(activityOf(retried, false).snag).toBeNull();
    const stuck = [step('1', 'read_diagram', 'completed'), step('2', 'update_diagram', 'failed', 'LAYOUT_CONSTRAINED')];
    expect(activityOf(stuck, false).snag).toEqual({ what: 'Changing the diagram', error: 'LAYOUT_CONSTRAINED' });
    // Not while it is still going: it may yet put it right.
    expect(activityOf(stuck, true).snag).toBeNull();
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

  it('watches something on its own screen while it thinks, a channel at a time, never a blank one', () => {
    for (const channel of CHANNELS) {
      for (let t = 0; t < CHANNEL_TICKS; t += 1) {
        const lit = channelFrame(channel, t);
        expect(lit.length, `${channel} at ${t}`).toBeGreaterThan(0);
        expect(lit.every(([x, y]) => x >= 5 && x <= 18 && y >= 7 && y <= 12)).toBe(true);
      }
    }
    expect(CHANNELS.map((_, i) => channelAt(i * CHANNEL_TICKS))).toEqual([...CHANNELS]);
    // The screen and its caption read one clock: whatever the moment, they name the same channel.
    for (const ms of [0, 1, CHANNEL_MS - 1, CHANNEL_MS, 1_761_300_000_000, 1_761_300_004_499, 1_761_300_004_500]) {
      const { tick, index } = channelClock(ms);
      expect(channelAt(tick)).toBe(CHANNELS[index % CHANNELS.length]);
    }
    // The frame held still under reduced motion has something on it too.
    expect(channelFrame(channelAt(0), 0).length).toBeGreaterThan(0);
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
