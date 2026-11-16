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
import { prepareProposal, type PreparedProposal } from './proposal';
import { silent, type Report } from './progress';
import { smallestArrange, type QualityReport } from './quality';
import { planArrange, planTidy, type ArrangePlanResult, type ArrangePreset, type TidyPlanResult } from './layoutPlan';
import { withDeadline } from './route';
import { legibilityOf, type Legibility } from './legibility';
import { routingAdvice } from './advice';
import { measureContext } from './place';
import { proportionAdvice, proportionFindings, type ProportionFinding } from './proportion';
import type { AgentStarter } from './starter';

export type Job =
  | { kind: 'compose'; raw: unknown; diagramId: string; starter?: AgentStarter }
  | { kind: 'update'; file: DraftDocument; path: DepthPath; ops: unknown; layout: unknown; scope?: unknown }
  | { kind: 'proposal'; file: DraftDocument; path: DepthPath; ops: unknown; layout: unknown; scope?: unknown }
  /** The editor's Arrange: `doc` is the room on screen (see `layoutPlan.ts`), bounded by work, not by `deadline`. */
  | { kind: 'arrange'; doc: DraftDocument; selection?: string[]; preset?: ArrangePreset }
  /** The editor's Tidy up. */
  | { kind: 'tidy'; doc: DraftDocument; scope?: string[] };

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
      /** What reads badly in the edited view although its lines are clean (see `proportion.ts`). */
      proportion?: ProportionFinding[];
    }
  | { kind: 'proposal'; prepared: PreparedProposal }
  | { kind: 'arrange'; result: ArrangePlanResult }
  | { kind: 'tidy'; result: TidyPlanResult };

/**
 * Runs `job`, repairing layouts until `deadline` (a `performance.now()` time), telling `report` where
 * it is (see `progress.ts`). Throws `AgentError`.
 */
export function runJob(job: Job, deadline: number, report: Report = silent): JobResult {
  // The editor's layout previews are bounded by a work budget of their own (`layoutPlan.ts`), the same
  // on any machine; `deadline` is the agent's time limit, which would make their result depend on speed.
  if (job.kind === 'arrange') return { kind: 'arrange', result: planArrange(job.doc, { ...(job.selection ? { selection: job.selection } : {}), ...(job.preset ? { preset: job.preset } : {}) }) };
  if (job.kind === 'tidy') return { kind: 'tidy', result: planTidy(job.doc, job.scope) };
  if (job.kind === 'compose') return { kind: 'compose', composed: compose(job.raw, job.diagramId, { deadline, report, ...(job.starter ? { starter: job.starter } : {}) }) };
  if (job.kind === 'proposal') {
    return withDeadline(deadline, () => {
      report('preparing');
      return { kind: 'proposal', prepared: prepareProposal(job.file, job.path, job.ops, job.layout, job.scope) };
    });
  }
  return withDeadline(deadline, () => {
    report('preparing');
    const result = applyUpdate(job.file, job.path, job.ops, job.layout, job.scope);
    const view = viewOf(result.file, job.path);
    // The edited view whole, as it would be committed: what the preview shows while it is checked.
    if (view && result.file !== job.file) report('routing', { nodes: view.nodes, edges: view.edges, flows: view.flows });
    const issues = result.quality.errors;
    const suggestedOp = view && issues.length ? smallestArrange(view, issues) : undefined;
    const legibility = view && result.file !== job.file ? legibilityOf(view.nodes, view.edges) : undefined;
    const proportion = view && legibility ? proportionFindings(view, measureContext()) : undefined;
    // Advised only about what the edit touched, and about a small overview only when the edit is what
    // made it small: the view as it was is measured for that one question.
    const was = proportion?.some((finding) => finding.kind === 'sparse') ? viewOf(job.file, job.path) : undefined;
    const wasSparse = Boolean(was && proportionFindings(was, measureContext()).some((finding) => finding.kind === 'sparse'));
    const edgeOf = new Map((view?.edges ?? []).map((edge) => [edge.id, edge]));
    const mine = (id: string) => {
      const edge = edgeOf.get(id);
      return result.touched.has(id) || Boolean(edge && (result.touched.has(edge.source) || result.touched.has(edge.target)));
    };
    return {
      kind: 'update',
      file: result.file,
      unchanged: result.file === job.file,
      counts: result.counts,
      // How the edit's own connectors could read better comes first: it is the advice to act on now.
      advisories: [...(view && legibility ? routingAdvice(view, legibility, result.touched) : []), ...(proportion ? proportionAdvice(proportion, mine, !wasSparse) : []), ...result.advisories],
      problems: issues.map((issue) => issue.message),
      ...(suggestedOp ? { suggestedOp } : {}),
      quality: result.quality,
      ...(legibility ? { legibility } : {}),
      ...(proportion ? { proportion } : {}),
    };
  });
}
