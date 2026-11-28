/**
 * The checks every diagram gets with no setup: what the diagram itself says is unfinished or
 * tangled. They read the drawing alone, need no repository, and never change it.
 *
 * - The semantic review (`review.ts`), every view of the file, as findings.
 * - Longer call loops than the review's two-part one, from the architecture model.
 * - A view whose parts don't match its level (`depth/c4.ts`).
 * - Connectors the model could not read as a relationship.
 */

import type { DraftDocument } from '../document/types';
import { levelAdvisories } from '../depth/c4';
import { effectiveLevel } from '../depth/level';
import { roomsOf } from '../depth/tree';
import { cyclesOf } from '../model/graph';
import { labelOf, modelOf, type ArchModel, type Relation } from '../model/model';
import { finding, type Finding, type Severity } from './finding';
import { reviewView, type ReviewCode } from './review';

/** How much each review finding matters to someone checking a diagram unattended. */
const REVIEW_SEVERITY: Record<ReviewCode, Severity> = {
  'call-cycle': 'warning',
  'shared-database': 'warning',
  'no-consumer': 'warning',
  'no-dead-letter': 'info',
  'dead-letter-source': 'warning',
  'no-producer': 'info',
  'cache-not-written': 'info',
  unconnected: 'info',
};

/** A view lists at most this many review findings; the rest are counted, not dropped silently. */
const PER_VIEW = 200;

const SYNC_CALLS = new Set(['calls', 'http', 'grpc', 'query', 'uses', 'dependsOn']);
const NOT_A_CALL = new Set(['async', 'event', 'callback', 'failure', 'fallback']);

/** A relation one part waits on: a plain call, as opposed to a message, a callback or a failure path. */
function isSyncCall(relation: Relation): boolean {
  return relation.directed && !relation.async && !(relation.kind && NOT_A_CALL.has(relation.kind)) && !!relation.semantic && SYNC_CALLS.has(relation.semantic);
}

export function builtinFindings(file: DraftDocument, model: ArchModel = modelOf(file)): Finding[] {
  const out: Finding[] = [];

  for (const room of roomsOf(file)) {
    const nested = room.path.length > 0;
    const level = effectiveLevel(file, room.path);
    const where = nested ? { room: [...room.path] } : {};
    for (const found of reviewView(room.graph.nodes, room.graph.edges, { level, nested, limit: PER_VIEW })) {
      out.push(
        finding({
          rule: `review/${found.code}`,
          class: 'advisory',
          severity: REVIEW_SEVERITY[found.code],
          subjects: found.ids,
          message: found.message,
          ...where,
        }),
      );
    }
    levelAdvisories(room.graph.nodes, level).forEach((message, index) => {
      out.push(finding({ rule: 'model/level-mix', class: 'advisory', severity: 'info', subjects: [], message, selector: String(index), ...where }));
    });
  }

  // The review names two parts that call each other. A loop through three or more is the same
  // trouble, harder to see.
  for (const loop of cyclesOf(model, isSyncCall)) {
    if (loop.length < 3) continue;
    const first = model.entities.get(loop[0]!) ?? model.boundaries.get(loop[0]!);
    const names = loop.map((id) => {
      const part = model.entities.get(id) ?? model.boundaries.get(id);
      return part ? quoted(labelOf(part), !!part.name) : id;
    });
    out.push(
      finding({
        rule: 'model/dependency-cycle',
        class: 'advisory',
        severity: 'warning',
        subjects: loop,
        message: `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''} call each other in a loop: none of them can change or fail on its own.`,
        ...(first && first.room.length ? { room: [...first.room] } : {}),
      }),
    );
  }

  const unread = new Map<string, { count: number; room: readonly string[]; edges: string[] }>();
  for (const entry of model.unread) {
    if (entry.reason === 'annotation' || entry.reason === 'self' || entry.reason === 'continued') continue;
    const key = `${entry.reason}\u0000${entry.room.join('/')}`;
    const group = unread.get(key) ?? { count: 0, room: entry.room, edges: [] };
    group.count += 1;
    if (group.edges.length < 20) group.edges.push(entry.edge);
    unread.set(key, group);
  }
  for (const [key, group] of unread) {
    const reason = key.split('\u0000')[0];
    out.push(
      finding({
        rule: reason === 'fan-out' ? 'model/fan-out' : 'model/dangling-junction',
        class: 'ambiguous',
        severity: 'info',
        subjects: group.edges,
        message:
          reason === 'fan-out'
            ? `${count(group.count, 'connector')} fan${group.count === 1 ? 's' : ''} out through Junctions to more parts than are read, so what ${group.count === 1 ? 'it connects' : 'they connect'} is left out of every check.`
            : `${count(group.count, 'connector')} ${group.count === 1 ? 'ends' : 'end'} at a Junction that leads nowhere, or ${group.count === 1 ? 'starts' : 'start'} at one nothing enters, so ${group.count === 1 ? 'it says' : 'they say'} nothing about what connects to what.`,
        ...(group.room.length ? { room: [...group.room] } : {}),
      }),
    );
  }

  return out;
}

function quoted(label: string, named: boolean): string {
  return named ? `"${label.length > 60 ? `${label.slice(0, 59)}…` : label}"` : label;
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
