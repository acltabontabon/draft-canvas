/**
 * What the person sees of an agent's work: nothing for a quick request, stages in order for a slow
 * one, a preview on the open diagram only while it is being prepared, and nothing left behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentActivity, SHOW_AFTER_MS } from '../../src/desktop/agentActivity';
import { createNode } from '../../src/document/factory';
import { useUiStore } from '../../src/store/uiStore';

const candidate = (label: string) => ({ nodes: [createNode({ id: 'a', type: 'service', x: 0, y: 0, text: label })], edges: [], flows: [] });
const op = (id: number, target: 'new' | 'open' | 'file' = 'open') => ({ id, tool: 'update_diagram' as const, title: 'Orders', target, path: [] });

beforeEach(() => {
  vi.useFakeTimers();
  agentActivity.__reset();
  useUiStore.getState().setAgentPreview(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agent activity', () => {
  it('shows nothing for a request that finishes quickly — never a flash, never a delay', () => {
    agentActivity.begin(op(1));
    agentActivity.progress(1, { seq: 1, stage: 'routing', candidate: candidate('A') });
    vi.advanceTimersByTime(SHOW_AFTER_MS - 50);
    agentActivity.end(1);
    vi.advanceTimersByTime(1000);
    expect(agentActivity.snapshot()).toEqual([]);
    expect(useUiStore.getState().agentPreview).toBeNull();
  });

  it('shows a slow one, previews it on the open diagram, and clears the preview when it ends', () => {
    agentActivity.begin(op(2));
    agentActivity.progress(2, { seq: 1, stage: 'arranging' });
    vi.advanceTimersByTime(SHOW_AFTER_MS);
    expect(agentActivity.snapshot()[0]).toMatchObject({ shown: true, stage: 'arranging' });
    agentActivity.progress(2, { seq: 2, stage: 'routing', candidate: candidate('B') });
    expect(useUiStore.getState().agentPreview).toMatchObject({ opId: 2, seq: 2 });
    agentActivity.end(2);
    expect(useUiStore.getState().agentPreview).toBeNull();
  });

  it('drops a late or duplicated report instead of going backwards', () => {
    agentActivity.begin(op(3));
    vi.advanceTimersByTime(SHOW_AFTER_MS);
    agentActivity.progress(3, { seq: 3, stage: 'repairing', candidate: candidate('new') });
    agentActivity.progress(3, { seq: 2, stage: 'routing', candidate: candidate('old') });
    agentActivity.progress(3, { seq: 3, stage: 'routing' });
    const now = agentActivity.snapshot()[0]!;
    expect(now.stage).toBe('repairing');
    expect(now.candidate?.nodes[0]?.text).toBe('new');
  });

  it('never previews a new or closed diagram on the canvas; the generation view opens only when allowed', () => {
    agentActivity.begin({ ...op(4, 'new'), tool: 'create_diagram' }, true);
    agentActivity.begin(op(5, 'file'));
    vi.advanceTimersByTime(SHOW_AFTER_MS);
    agentActivity.progress(4, { seq: 1, stage: 'routing', candidate: candidate('C') });
    agentActivity.progress(5, { seq: 1, stage: 'routing', candidate: candidate('D') });
    expect(useUiStore.getState().agentPreview).toBeNull();
    const [created, closed] = agentActivity.snapshot();
    expect(created).toMatchObject({ watching: true });
    expect(closed).toMatchObject({ watching: false });
  });

  it('stops previewing once cancelled, and ignores progress once the change is being applied', () => {
    agentActivity.begin(op(6));
    vi.advanceTimersByTime(SHOW_AFTER_MS);
    agentActivity.progress(6, { seq: 1, stage: 'routing', candidate: candidate('E') });
    agentActivity.cancelling(6);
    expect(useUiStore.getState().agentPreview).toBeNull();
    agentActivity.begin(op(7));
    agentActivity.applying(7);
    agentActivity.progress(7, { seq: 1, stage: 'routing' });
    expect(agentActivity.snapshot().find((o) => o.id === 7)).toMatchObject({ applying: true, stage: 'finishing' });
  });

  it('keeps a bounded number of entries', () => {
    for (let id = 10; id < 20; id += 1) agentActivity.begin(op(id));
    expect(agentActivity.snapshot().map((o) => o.id)).toEqual([16, 17, 18, 19]);
  });
});
