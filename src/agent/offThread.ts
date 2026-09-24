/**
 * Runs an agent request's heavy half (`jobs.ts`) off the page's main thread, on a worker, so the
 * editor stays responsive however large the request — and bounds it: repairs stop at a soft budget,
 * and a worker still busy at the hard limit is terminated and the request refused with nothing
 * changed. Where a worker isn't available or can't measure text, the page runs the job itself,
 * after yielding once so it can paint, under the same soft budget.
 *
 * Progress (`progress.ts`) arrives as the worker posts it, numbered, before the result; the page
 * fallback reports synchronously, so there it only ever amounts to the final state.
 */

import { AgentError, type AgentErrorJson } from './errors';
import { runJob, type Job, type JobResult } from './jobs';
import type { Candidate, Stage } from './progress';

/** Repairs stop here; what is left unrepaired is reported, not waited for. */
export const SOFT_BUDGET_MS = 6_000;
/** A worker still busy by now is stopped. Below the shell's 30 s budget before a commit. */
export const HARD_LIMIT_MS = 20_000;

export interface Progress {
  /** Increases with every report of one job: an older one arriving late is ignored. */
  seq: number;
  stage: Stage;
  candidate?: Candidate;
}

type Reply =
  | { id: number; unsupported: true }
  | { id: number; ok: true; value: JobResult }
  | { id: number; ok: false; error: AgentErrorJson }
  | { id: number; progress: Progress };

interface Waiting {
  resolve: (reply: Exclude<Reply, { progress: Progress }>) => void;
  progress?: (progress: Progress) => void;
}

let worker: Worker | null = null;
/** The worker said it can't measure text here: every job runs on the page from now on. */
let workerUnusable = false;
let nextId = 1;
const pending = new Map<number, Waiting>();

function startWorker(): Worker | null {
  if (worker) return worker;
  if (workerUnusable || typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'draft-canvas-agent' });
  } catch {
    workerUnusable = true;
    return null;
  }
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const waiting = pending.get(event.data.id);
    if ('progress' in event.data) {
      waiting?.progress?.(event.data.progress);
      return;
    }
    pending.delete(event.data.id);
    waiting?.resolve(event.data);
  };
  worker.onerror = () => {
    // A worker that fails to load (a CSP or bundling fault — see `workerSafeEntities` in
    // `vite.config.ts` for one that did) must not strand requests.
    workerUnusable = true;
    stopWorker();
  };
  return worker;
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  for (const waiting of pending.values()) waiting.resolve({ id: 0, unsupported: true });
  pending.clear();
}

const onPage = async (job: Job, progress?: (progress: Progress) => void): Promise<JobResult> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  let seq = 0;
  return runJob(job, performance.now() + SOFT_BUDGET_MS, (stage, candidate) => progress?.({ seq: (seq += 1), stage, ...(candidate ? { candidate } : {}) }));
};

export async function runOffThread(job: Job, progress?: (progress: Progress) => void): Promise<JobResult> {
  const thread = startWorker();
  if (!thread) return onPage(job, progress);
  const id = nextId++;
  const reply = await new Promise<Exclude<Reply, { progress: Progress }> | 'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // The only way to stop a runaway computation: the next request starts a fresh worker.
      stopWorker();
      resolve('timeout');
    }, HARD_LIMIT_MS);
    pending.set(id, {
      resolve: (answer) => {
        clearTimeout(timer);
        resolve(answer);
      },
      ...(progress ? { progress } : {}),
    });
    thread.postMessage({ id, job, budgetMs: SOFT_BUDGET_MS });
  });
  if (reply === 'timeout') {
    throw new AgentError('LAYOUT_FAILED', `Arranging this took longer than ${HARD_LIMIT_MS / 1000} s and was stopped. Nothing changed.`, {
      hint: 'Send fewer elements per request — build the diagram in steps, or split it into views with inside.',
    });
  }
  if ('unsupported' in reply) {
    workerUnusable = true;
    stopWorker();
    return onPage(job, progress);
  }
  if (!reply.ok) throw new AgentError(reply.error.code, reply.error.message, { hint: reply.error.hint, retryable: reply.error.retryable, details: reply.error.details });
  return reply.value;
}

/** Test seam: whether jobs are going to the worker (false once it has failed to load or measure). */
export function __workerUsable(): boolean {
  return !workerUnusable && typeof Worker !== 'undefined';
}

/** Test seam: forget the worker, so the next job starts afresh. */
export function __resetOffThread(): void {
  stopWorker();
  workerUnusable = false;
}
