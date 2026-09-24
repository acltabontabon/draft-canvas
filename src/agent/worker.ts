/**
 * The worker thread agent requests are arranged on (`offThread.ts` starts it), so a large diagram
 * never holds the editor still. It measures text with its own OffscreenCanvas — the same canvas text
 * API, fonts and wrapping as the page — and says so up front when it can't (older WebKit has no 2D
 * OffscreenCanvas), in which case the page does the work itself rather than accept guessed widths.
 *
 * While a job runs it posts progress: every change of stage, and whole candidate arrangements no more
 * than every `CANDIDATE_EVERY_MS` (a preview that redraws faster only flickers, and each candidate is
 * a copy of the view across the thread boundary). The final result follows as its own reply.
 */

import { createOffscreenMeasurer, setMeasurer } from '../render/text/measure';
import { toAgentError } from './errors';
import { runJob, type Job } from './jobs';
import type { Report } from './progress';

interface Incoming {
  id: number;
  job: Job;
  budgetMs: number;
}

const CANDIDATE_EVERY_MS = 250;

const measurer = createOffscreenMeasurer();
if (measurer) setMeasurer(measurer);

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<Incoming>) => void) | null };

scope.onmessage = (event) => {
  const { id, job, budgetMs } = event.data;
  if (!measurer) {
    scope.postMessage({ id, unsupported: true });
    return;
  }
  let lastStage: string | undefined;
  let lastCandidate = Number.NEGATIVE_INFINITY;
  let seq = 0;
  const report: Report = (stage, candidate) => {
    const now = performance.now();
    const send = candidate && now - lastCandidate >= CANDIDATE_EVERY_MS;
    if (!send && stage === lastStage) return;
    lastStage = stage;
    if (send) lastCandidate = now;
    seq += 1;
    scope.postMessage({ id, progress: { seq, stage, ...(send ? { candidate } : {}) } });
  };
  try {
    scope.postMessage({ id, ok: true, value: runJob(job, performance.now() + budgetMs, report) });
  } catch (error) {
    scope.postMessage({ id, ok: false, error: toAgentError(error) });
  }
};
