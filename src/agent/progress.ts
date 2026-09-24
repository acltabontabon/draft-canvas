/**
 * What an agent request's heavy half reports while it works: the stage it is really in (never a
 * made-up percentage — nothing here can be measured that way), and, at the few points where one
 * exists, a *complete* candidate: every shape placed and every connector anchored. Never a half-built
 * graph, so a preview can't show a dangling connector or a shape still at the origin.
 */

import type { DraftEdge, DraftFlow, DraftNode } from '../document/types';

export type Stage = 'preparing' | 'arranging' | 'routing' | 'repairing' | 'finishing';

/** A whole arrangement of one view: what a preview draws. */
export interface Candidate {
  nodes: DraftNode[];
  edges: DraftEdge[];
  flows: DraftFlow[];
}

export type Report = (stage: Stage, candidate?: Candidate) => void;

/** What the person is told, in the status line — the stage as a phrase. */
export const STAGE_TEXT: Record<Stage, string> = {
  preparing: 'Preparing diagram',
  arranging: 'Arranging components',
  routing: 'Routing connections',
  repairing: 'Trying a roomier layout',
  finishing: 'Finishing layout',
};

export const silent: Report = () => {};
