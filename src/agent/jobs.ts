/**
 * The heavy half of an agent request — arranging a new diagram, or working out an edit and checking
 * it reads — as one plain function of plain data, so it can run on a worker thread (`worker.ts`) or,
 * where a worker can't measure text, on the page (`offThread.ts` decides). Nothing here touches the
 * editor: the result is data the page then commits, or doesn't.
 */

import { viewOf, type DepthPath } from '../depth/tree';
import type { DraftDocument } from '../document/types';
import { compose, type Composed } from './compile';
import { applyUpdate, type PatchResult } from './patch';
import { silent, type Report } from './progress';
import { type QualityIssue, type QualityReport } from './quality';
import { withDeadline } from './route';
import { legibilityOf, type Legibility } from './legibility';

export type Job =
  | { kind: 'compose'; raw: unknown; diagramId: string }
  | { kind: 'update'; file: DraftDocument; path: DepthPath; ops: unknown; layout: unknown; scope?: unknown };

export type JobResult =
  | { kind: 'compose'; composed: Composed }
  | {
      kind: 'update';
      file: DraftDocument;
      /** The ops changed nothing (the file came back as it went in). */
      unchanged: boolean;
      counts: PatchResult['counts'];
      advisories: string[];
      /** Readability problems the edit would leave, among what it touched. */
      problems: string[];
      /** When there are problems: the smallest op that would make room (an `arrange` over a scope). */
      suggestedOp?: Record<string, unknown>;
      /** Errors and warnings among what the request touched — see `PatchResult['quality']`. */
      quality: QualityReport;
      /** How the edited view reads as a whole (see `legibility.ts`) — absent when nothing changed. */
      legibility?: Legibility;
    };

/**
 * Runs `job`, repairing layouts until `deadline` (a `performance.now()` time), telling `report` where
 * it is (see `progress.ts`). Throws `AgentError`.
 */
export function runJob(job: Job, deadline: number, report: Report = silent): JobResult {
  if (job.kind === 'compose') return { kind: 'compose', composed: compose(job.raw, job.diagramId, { deadline, report }) };
  return withDeadline(deadline, () => {
    report('preparing');
    const result = applyUpdate(job.file, job.path, job.ops, job.layout, job.scope);
    const view = viewOf(result.file, job.path);
    // The edited view whole, as it would be committed: what the preview shows while it is checked.
    if (view && result.file !== job.file) report('routing', { nodes: view.nodes, edges: view.edges, flows: view.flows });
    const issues = result.quality.errors;
    const suggestedOp = view && issues.length ? smallestArrange(view, issues) : undefined;
    return {
      kind: 'update',
      file: result.file,
      unchanged: result.file === job.file,
      counts: result.counts,
      advisories: result.advisories,
      problems: issues.map((issue) => issue.message),
      ...(suggestedOp ? { suggestedOp } : {}),
      quality: result.quality,
      ...(view && result.file !== job.file ? { legibility: legibilityOf(view.nodes, view.edges) } : {}),
    };
  });
}

/**
 * The narrowest `arrange` that could make room for what didn't fit: the innermost boundary holding
 * every shape a problem names, or the whole view when they don't share one.
 */
function smallestArrange(view: DraftDocument, issues: readonly QualityIssue[]): Record<string, unknown> {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const chains = issues
    .flatMap((issue) => issue.ids)
    .filter((id) => byId.has(id))
    .map((id) => {
      const chain: string[] = [];
      let at = byId.get(id)?.parentId;
      while (at && !chain.includes(at)) {
        chain.push(at);
        at = byId.get(at)?.parentId;
      }
      return chain;
    });
  const shared = chains[0]?.find((group) => chains.every((chain) => chain.includes(group)));
  return shared ? { op: 'arrange', scope: { group: shared } } : { op: 'arrange' };
}
