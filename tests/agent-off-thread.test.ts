import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HARD_LIMIT_MS, __resetOffThread, __workerUsable, runOffThread } from '../src/agent/offThread';
import type { Job } from '../src/agent/jobs';

/** The first worker ever started is stuck on a runaway job and answers nothing; later ones answer. */
class FakeWorker {
  static started = 0;
  static received: number[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  private readonly index: number;

  constructor() {
    this.index = FakeWorker.started += 1;
  }

  postMessage(message: { id: number }) {
    FakeWorker.received.push(message.id);
    if (this.index === 1) return; // stuck on the runaway
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.({ data: { id: message.id, ok: true, value: { kind: 'probe', id: message.id } } } as MessageEvent);
    });
  }

  terminate() {
    this.terminated = true;
  }
}

describe('agent jobs off the main thread', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.started = 0;
    FakeWorker.received = [];
    vi.stubGlobal('Worker', FakeWorker);
    __resetOffThread();
  });
  afterEach(() => {
    __resetOffThread();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps using a worker after one job ran past the hard limit — the next one gets a fresh worker', async () => {
    const job = { kind: 'probe' } as unknown as Job;
    const runaway = runOffThread(job);
    const queued = runOffThread(job); // posted to the same worker, behind the runaway
    const refused = expect(runaway).rejects.toMatchObject({ code: 'LAYOUT_FAILED' });

    await vi.advanceTimersByTimeAsync(HARD_LIMIT_MS + 1);
    await refused;

    // The job queued behind it was not refused and did not fall back to the page: a new worker ran it.
    await expect(queued).resolves.toMatchObject({ kind: 'probe' });
    expect(FakeWorker.started).toBe(2);
    expect(__workerUsable()).toBe(true);
  });
});
