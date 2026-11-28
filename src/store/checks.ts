import { sameArchitecture } from '../document/fieldClasses';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { countBySeverity, sortFindings, type Finding, type Severity } from '../checks/finding';
import { builtinFindings } from '../checks/rules';
import { walkGraphs } from '../depth/tree';

/**
 * The editor's one door to the checks: what the drawing itself says is unfinished or tangled, in
 * every view of the open file.
 *
 * A view, like an outage walk: never saved, undone, shared or exported, and it changes nothing by
 * itself. The findings are remembered against what they were read from. A drag hands the store a
 * new file every frame, but moving a shape changes nothing a check reads, so a file whose rooms
 * hold the same connectors and the same shapes (by what they are, not where) keeps the findings
 * it already has. Only the drawing is read here; evidence is held against a repository from the
 * command line (`cli/`), where there is one.
 */
export interface Checks {
  /** Most severe first. */
  findings: Finding[];
  counts: Record<Severity, number>;
}

interface Memo {
  rooms: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] }[];
  checks: Checks;
}

let memo: Memo | null = null;

function sameNodes(a: readonly DraftNode[], b: readonly DraftNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const before = a[index]!;
    const after = b[index]!;
    if (before !== after && (before.id !== after.id || !sameArchitecture(before, after))) return false;
  }
  return true;
}

/** What the checks find in `file`: the same object for as long as nothing they read has changed. */
export function checksOf(file: DraftDocument): Checks {
  if (memo) {
    const known = memo.rooms;
    let index = 0;
    let same = true;
    walkGraphs(file, (graph) => {
      const room = known[index];
      index += 1;
      if (!same) return;
      if (!room || room.edges !== graph.edges || !sameNodes(room.nodes, graph.nodes)) {
        same = false;
        return;
      }
      // Keep the newest array, so the next comparison is by identity again.
      room.nodes = graph.nodes;
    });
    if (same && index === known.length) return memo.checks;
  }
  const rooms: Memo['rooms'] = [];
  walkGraphs(file, (graph) => rooms.push({ nodes: graph.nodes, edges: graph.edges }));
  const findings = sortFindings(builtinFindings(file));
  memo = { rooms, checks: { findings, counts: countBySeverity(findings) } };
  return memo.checks;
}
