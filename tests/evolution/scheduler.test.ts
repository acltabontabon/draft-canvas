import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, IDLE_STATE, decide, step, type SchedulerEvent, type SchedulerState } from '../../src/evolution/scheduler';

const run = (...events: SchedulerEvent[]): SchedulerState => events.reduce(step, IDLE_STATE);

describe('the checkpoint scheduler', () => {
  it('does nothing until something is edited', () => {
    expect(decide(IDLE_STATE, 1_000_000, true)).toEqual({ kind: 'idle' });
  });

  it('records after the idle period, not at every mutation', () => {
    const state = run({ kind: 'edit', at: 0, generation: 1 }, { kind: 'edit', at: 1000, generation: 2 });
    expect(decide(state, 20_000, true)).toEqual({ kind: 'wait', until: 31_000 });
    expect(decide(state, 31_000, true)).toEqual({ kind: 'capture' });
  });

  it('records sustained editing at the maximum interval', () => {
    let state = IDLE_STATE;
    for (let t = 0; t <= 125_000; t += 5_000) state = step(state, { kind: 'edit', at: t, generation: t });
    expect(decide(state, 120_000, true)).toEqual({ kind: 'capture' });
  });

  it('waits for a gesture to end rather than recording half of it', () => {
    const state = run({ kind: 'edit', at: 0, generation: 1 });
    expect(decide(state, 40_000, false)).toEqual({ kind: 'wait', until: 40_000 + DEFAULT_SCHEDULE.boundaryRetryMs });
    expect(decide(state, 40_500, true)).toEqual({ kind: 'capture' });
  });

  it('keeps edits made during a capture pending for the next one', () => {
    let state = run({ kind: 'edit', at: 0, generation: 1 }, { kind: 'started', at: 30_000, generation: 1 }, { kind: 'edit', at: 30_100, generation: 2 });
    expect(decide(state, 30_200, true)).toEqual({ kind: 'idle' });
    state = step(state, { kind: 'succeeded', at: 30_500 });
    expect(state.dirtySince).toBe(30_500);
    expect(decide(state, 61_000, true)).toEqual({ kind: 'capture' });
  });

  it('is clean after a capture that covered every edit', () => {
    const state = run({ kind: 'edit', at: 0, generation: 3 }, { kind: 'started', at: 30_000, generation: 3 }, { kind: 'succeeded', at: 30_100 });
    expect(decide(state, 1_000_000, true)).toEqual({ kind: 'idle' });
  });

  it('coalesces an agent’s batch into one capture when it settles', () => {
    let state = IDLE_STATE;
    for (let i = 0; i < 10; i += 1) state = step(state, { kind: 'edit', at: i * 200, generation: i + 1, agent: true });
    expect(decide(state, 2_500, true).kind).toBe('wait');
    state = step(state, { kind: 'agent-settled', at: 3_000 });
    expect(decide(state, 3_000, true)).toEqual({ kind: 'capture' });
  });

  it('backs off after a failure and keeps the edits pending', () => {
    let state = run({ kind: 'edit', at: 0, generation: 1 }, { kind: 'started', at: 30_000, generation: 1 }, { kind: 'failed', at: 30_000 });
    expect(decide(state, 31_000, true)).toEqual({ kind: 'wait', until: 32_000 });
    state = step(step(state, { kind: 'started', at: 32_000, generation: 1 }), { kind: 'failed', at: 32_000 });
    expect(decide(state, 33_000, true)).toEqual({ kind: 'wait', until: 36_000 });
    expect(state.dirtySince).toBe(0);
  });

  it('answers an explicit request at the next boundary', () => {
    const state = run({ kind: 'request', at: 5 });
    expect(decide(state, 5, false).kind).toBe('wait');
    expect(decide(state, 6, true)).toEqual({ kind: 'capture' });
  });
});
