/**
 * The semantic three-way merge (ADR-7): given the common ancestor and two descendants of a diagram,
 * combine what each side changed and name, precisely, what cannot be combined without a decision.
 *
 * It works on the document, never on text. Changes are matched by id (`collab/diffFile`) and merged
 * in units that mean something together:
 *
 * | Unit                | Fields merged as one                                         |
 * | ------------------- | ------------------------------------------------------------ |
 * | connector ends      | source, target, both anchors, portal                         |
 * | connector path      | routing, routeMode, waypoints                                |
 * | geometry            | x, y, width, height                                          |
 * | containment         | parentId, and which room it is in                            |
 * | junction link       | link, and the label it shares with its group                 |
 * | sequence            | the whole payload                                            |
 * | style               | the diagram's whole style, drawings included                 |
 *
 * Everything else merges field by field. The same change on both sides is never a conflict. A
 * conflict is never resolved by "last writer wins": it is listed, with all three versions, until
 * the person chooses. And the combined result is validated whole — anything the validator would
 * have to repair (a connector to a shape the other side removed, a boundary inside itself) becomes
 * a conflict too, never a silent drop.
 */
import { keyOf, type Change } from '../collab/changes';
import { applyChanges } from '../collab/apply';
import { diffFile, nodeValue } from '../collab/diff';
import { sameValue } from '../collab/equal';
import { indexOf } from '../collab/fileIndex';
import { repairReferences } from '../collab/repair';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { normalizeDocument } from '../document/validate';

export type Side = 'ours' | 'theirs' | 'base';

export type ConflictKind =
  /** Both changed the same unit of the same element, differently. */
  | 'both-changed'
  /** One side removed what the other changed. */
  | 'removed-and-changed'
  /** Both added something under the same id, differently. */
  | 'same-id'
  /** Both moved it into different rooms. */
  | 'moved-apart'
  /** The diagram's title, settings or style, changed differently. */
  | 'file'
  /** The combination is invalid on its own (a reference to something removed, a boundary in itself). */
  | 'combination';

export interface Conflict {
  id: string;
  kind: ConflictKind;
  /** The key of the element (`node:n_1`) or file field (`title`). */
  key: string;
  /** The unit within the element, for `both-changed` (`geometry`, `ends`, a field name). */
  unit?: string;
  label: string;
  /** What each side holds for it: the change it made, or `null` for "left it as it was". */
  ours: Change | null;
  theirs: Change | null;
  /** Plain words for the person. */
  description: string;
}

export interface MergeResult {
  /** The combination with every conflict resolved toward the choice given (`ours` by default). */
  candidate: DraftDocument;
  conflicts: Conflict[];
  /** How many changes combined without a decision. */
  combined: number;
}

const NODE_UNITS: Record<string, readonly string[]> = {
  geometry: ['x', 'y', 'width', 'height'],
  containment: ['parentId'],
  'junction link': ['link'],
  sequence: ['sequence'],
};

const EDGE_UNITS: Record<string, readonly string[]> = {
  ends: ['source', 'target', 'sourceAnchor', 'targetAnchor', 'portal'],
  path: ['routing', 'routeMode', 'waypoints'],
};

function unitsFor(kind: 'node' | 'edge', value: Record<string, unknown>): Map<string, string[]> {
  const grouped = kind === 'node' ? NODE_UNITS : EDGE_UNITS;
  const owned = new Set(Object.values(grouped).flat());
  const units = new Map<string, string[]>(Object.entries(grouped).map(([name, fields]) => [name, [...fields]]));
  // A linked Junction's label is the group's: it moves with its link.
  if (kind === 'node' && value.type === 'junction') units.get('junction link')!.push('text');
  for (const field of Object.keys(value)) if (!owned.has(field) && !(kind === 'node' && field === 'text' && value.type === 'junction') && field !== 'id' && field !== 'inside') units.set(field, [field]);
  return units;
}

function pick(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (value[field] !== undefined) out[field] = value[field];
  return out;
}

function labelOf(value: { text?: string; title?: string; label?: string; type?: string } | null | undefined, fallback: string): string {
  return (value?.text ?? value?.title ?? value?.label ?? value?.type ?? fallback).split('\n')[0]!.slice(0, 80) || fallback;
}

/** Per element, both sides' changes. */
function byKey(changes: Change[]): Map<string, Change[]> {
  const out = new Map<string, Change[]>();
  for (const change of changes) {
    const key = keyOf(change);
    out.set(key, [...(out.get(key) ?? []), change]);
  }
  return out;
}

function valueChange(changes: Change[] | undefined): Change | undefined {
  return changes?.find((change) => change.kind !== 'move');
}

function moveChange(changes: Change[] | undefined): Extract<Change, { kind: 'move' }> | undefined {
  return changes?.find((change): change is Extract<Change, { kind: 'move' }> => change.kind === 'move');
}

type Choices = ReadonlyMap<string, Side>;

/**
 * Merges `ours` and `theirs`, both descended from `base`. `choices` resolves conflicts by id;
 * an unresolved conflict takes `ours` in the candidate (and stays listed).
 */
export function merge(base: DraftDocument, ours: DraftDocument, theirs: DraftDocument, choices: Choices = new Map()): MergeResult {
  const mine = byKey(diffFile(base, ours));
  const yours = byKey(diffFile(base, theirs));
  const baseIndex = indexOf(base);
  const conflicts: Conflict[] = [];
  let out: Change[] = [];
  let combined = 0;

  const choose = (conflict: Conflict, take: { ours: Change[]; theirs: Change[]; base: Change[] }) => {
    conflicts.push(conflict);
    out.push(...take[choices.get(conflict.id) ?? 'ours']);
  };

  const keys = new Set([...mine.keys(), ...yours.keys()]);
  for (const key of [...keys].sort()) {
    const a = mine.get(key) ?? [];
    const b = yours.get(key) ?? [];
    if (b.length === 0) {
      out.push(...a);
      combined += a.length;
      continue;
    }
    if (a.length === 0) {
      out.push(...b);
      combined += b.length;
      continue;
    }
    if (sameValue(a, b)) {
      out.push(...a);
      combined += a.length;
      continue;
    }

    // Moves between rooms: one side moving is fine; both moving to different rooms is a decision.
    const moveA = moveChange(a);
    const moveB = moveChange(b);
    if (moveA && moveB && moveA.room !== moveB.room) {
      choose(
        { id: `${key}#room`, kind: 'moved-apart', key, label: key, ours: moveA, theirs: moveB, description: 'Each side moved it into a different view.' },
        { ours: [moveA], theirs: [moveB], base: [] },
      );
    } else if (moveA || moveB) {
      out.push((moveA ?? moveB)!);
      combined += 1;
    }

    const valueA = valueChange(a);
    const valueB = valueChange(b);
    if (!valueA || !valueB) {
      const one = valueA ?? valueB;
      if (one) {
        out.push(one);
        combined += 1;
      }
      continue;
    }
    if (sameValue(valueA, valueB)) {
      out.push(valueA);
      combined += 1;
      continue;
    }

    if (valueA.kind === 'title' || valueA.kind === 'settings' || valueA.kind === 'style' || valueA.kind === 'level' || valueA.kind === 'order') {
      const what = valueA.kind === 'style' ? 'how the diagram is drawn' : valueA.kind === 'order' ? 'the order of elements' : valueA.kind === 'level' ? 'what a view shows' : `the diagram’s ${valueA.kind}`;
      choose({ id: key, kind: 'file', key, label: what, ours: valueA, theirs: valueB, description: `Both sides changed ${what}, differently.` }, { ours: [valueA], theirs: [valueB], base: [] });
      continue;
    }

    const elementA = valueA as Extract<Change, { value: unknown; id: string }>;
    const elementB = valueB as Extract<Change, { value: unknown; id: string }>;
    const existed = valueA.kind === 'point' ? base.openPoints.some((point) => point.id === elementA.id) : (valueA.kind === 'node' ? baseIndex.nodes : valueA.kind === 'edge' ? baseIndex.edges : valueA.kind === 'flow' ? baseIndex.flows : baseIndex.ink).has(elementA.id);
    const label = labelOf((elementA.value ?? elementB.value ?? null) as never, valueA.kind);

    if (!existed) {
      choose(
        { id: key, kind: 'same-id', key, label, ours: valueA, theirs: valueB, description: 'Both sides added something different under the same identity.' },
        { ours: [valueA], theirs: [valueB], base: [] },
      );
      continue;
    }
    if (elementA.value === null || elementB.value === null) {
      const removedBy = elementA.value === null ? 'This architecture' : 'The other';
      choose(
        { id: key, kind: 'removed-and-changed', key, label, ours: valueA, theirs: valueB, description: `${removedBy} removed it; the other changed it.` },
        { ours: [valueA], theirs: [valueB], base: [] },
      );
      continue;
    }
    if (valueA.kind !== 'node' && valueA.kind !== 'edge') {
      choose({ id: key, kind: 'both-changed', key, label, ours: valueA, theirs: valueB, description: 'Both sides changed it differently.' }, { ours: [valueA], theirs: [valueB], base: [] });
      continue;
    }

    // Both changed the same shape or connector: merge unit by unit.
    const baseValue = (valueA.kind === 'node' ? nodeValue(baseIndex.nodes.get(elementA.id)!.value) : baseIndex.edges.get(elementA.id)!.value) as unknown as Record<string, unknown>;
    const ourValue = elementA.value as Record<string, unknown>;
    const theirValue = elementB.value as Record<string, unknown>;
    const units = unitsFor(valueA.kind, { ...baseValue, ...ourValue, ...theirValue });
    const merged: Record<string, unknown> = { ...baseValue };
    for (const [unit, fields] of units) {
      const was = pick(baseValue, fields);
      const mineUnit = pick(ourValue, fields);
      const theirsUnit = pick(theirValue, fields);
      const mineChanged = !sameValue(was, mineUnit);
      const theirsChanged = !sameValue(was, theirsUnit);
      let take = was;
      if (mineChanged && theirsChanged && !sameValue(mineUnit, theirsUnit)) {
        const id = `${key}#${unit}`;
        conflicts.push({
          id,
          kind: 'both-changed',
          key,
          unit,
          label,
          ours: valueA,
          theirs: valueB,
          description: `Both sides changed its ${unit === 'ends' ? 'ends' : unit === 'path' ? 'path' : unit}.`,
        });
        const choice = choices.get(id) ?? 'ours';
        take = choice === 'ours' ? mineUnit : choice === 'theirs' ? theirsUnit : was;
      } else if (mineChanged) {
        take = mineUnit;
      } else if (theirsChanged) {
        take = theirsUnit;
      }
      for (const field of fields) delete merged[field];
      Object.assign(merged, take);
    }
    combined += 1;
    out.push({ ...valueA, value: merged } as Change);
  }

  // The combination, applied to the ancestor and checked whole.
  let applied = applyChanges(base, out);
  let repaired = repairReferences(applied);
  // A combination conflict is decided like any other: the chosen side's version of the element and
  // of what it refers to. Past bug: the choice was never read, so "Keep this" on a connector to a
  // shape the other side removed still dropped the connector, and Merge committed the drop.
  // Settling can uncover a new loss (a restored shape's boundary was removed too), so it repeats,
  // bounded; each conflict is settled once, in the pass that found it.
  const sides = { ours: { file: ours, changes: mine }, theirs: { file: theirs, changes: yours }, base: { file: base, changes: new Map<string, Change[]>() } };
  const listed = new Set<string>();
  for (let pass = 0; pass < 8; pass += 1) {
    const found = combinationConflicts(applied, repaired, mine, yours).filter((conflict) => !listed.has(conflict.id));
    if (found.length === 0) break;
    for (const conflict of found) {
      listed.add(conflict.id);
      conflicts.push(conflict);
      out = settle(out, conflict.key, applied, sides[choices.get(conflict.id) ?? 'ours']);
    }
    applied = applyChanges(base, out);
    repaired = repairReferences(applied);
  }
  const normalized = normalizeDocument(JSON.parse(JSON.stringify(repaired)));
  const candidate = normalized.ok ? normalized.document : repaired;
  if (normalized.ok && normalized.repairs.length > 0) {
    conflicts.push({ id: 'validation', kind: 'combination', key: 'file', label: 'The combined diagram', ours: null, theirs: null, description: `Combining needs repairs: ${normalized.repairs.join('; ')}` });
  }
  conflicts.push(...cycles(candidate));
  return { candidate, conflicts, combined };
}

/** What `repairReferences` had to drop from the combination: each is a decision, not a repair. */
function combinationConflicts(applied: DraftDocument, repaired: DraftDocument, mine: Map<string, Change[]>, yours: Map<string, Change[]>): Conflict[] {
  if (applied === repaired) return [];
  const out: Conflict[] = [];
  const before = indexOf(applied);
  const after = indexOf(repaired);
  const lost = <T extends { id: string }>(kind: string, a: Map<string, { value: T }>, b: Map<string, { value: T }>) => {
    for (const [id, located] of a) {
      const now = b.get(id);
      if (now && sameValue(now.value, located.value)) continue;
      const key = `${kind}:${id}`;
      out.push({
        id: `${key}#combination`,
        kind: 'combination',
        key,
        label: labelOf(located.value as never, kind),
        ours: valueChange(mine.get(key)) ?? null,
        theirs: valueChange(yours.get(key)) ?? null,
        description: now ? 'Together, the two sides leave it pointing at something that no longer exists.' : 'Together, the two sides leave it connected to something that was removed.',
      });
    }
  };
  lost<DraftEdge>('edge', before.edges, after.edges);
  lost<DraftNode>('node', before.nodes, after.nodes);
  return out;
}

interface SideOf {
  file: DraftDocument;
  changes: Map<string, Change[]>;
}

/**
 * Resolves one combination conflict toward `side`: its references (a connector's ends, a shape's
 * boundary) become that side's, and whatever they lead to that the combination broke (removed, in
 * another view, or re-parented into a loop) is restored as that side has it. If that side has no such
 * element, it goes. Everything else the other side did to the element itself is kept.
 */
function settle(out: Change[], key: string, applied: DraftDocument, side: SideOf): Change[] {
  const [kind, id] = key.split(':') as ['node' | 'edge', string];
  const now = indexOf(applied);
  const chosen = indexOf(side.file);
  let next = out;
  const take = (k: string) => {
    next = [...next.filter((change) => keyOf(change) !== k), ...(side.changes.get(k) ?? [])];
  };
  const fields = kind === 'edge' ? EDGE_UNITS.ends! : NODE_UNITS.containment!;
  const current = (kind === 'edge' ? now.edges : now.nodes).get(id);
  const wanted = (kind === 'edge' ? chosen.edges : chosen.nodes).get(id);
  if (!wanted || !current) {
    take(key);
    return next;
  }
  const own = (kind === 'node' ? nodeValue(current.value as DraftNode) : current.value) as unknown as Record<string, unknown>;
  const refs = wanted.value as unknown as Record<string, unknown>;
  if (!sameValue(pick(own, fields), pick(refs, fields))) {
    const value: Record<string, unknown> = { ...own };
    for (const field of fields) delete value[field];
    Object.assign(value, pick(refs, fields));
    next = [...next.filter((change) => keyOf(change) !== key || change.kind === 'move'), { kind, id, room: current.room, value } as Change];
  }
  if (kind === 'edge') {
    const edge = wanted.value as DraftEdge;
    for (const end of [edge.source, edge.target]) {
      if (now.nodes.get(end)?.room !== current.room) take(`node:${end}`);
    }
  } else {
    // The chosen side's chain of boundaries is valid in its own file; restore any link of it the
    // combination changed. Bounded by that chain, and by `seen` against a file that is not valid.
    const seen = new Set<string>([id]);
    let parent = (wanted.value as DraftNode).parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const there = chosen.nodes.get(parent);
      const here = now.nodes.get(parent);
      if (!there) break;
      if (!here || here.room !== there.room || here.value.parentId !== there.value.parentId) take(`node:${parent}`);
      parent = there.value.parentId;
    }
  }
  return next;
}

/** Boundaries that, combined, would sit inside themselves. */
function cycles(file: DraftDocument): Conflict[] {
  const out: Conflict[] = [];
  const index = indexOf(file);
  for (const [id, located] of index.nodes) {
    const seen = new Set<string>([id]);
    let parent = located.value.parentId;
    while (parent) {
      if (seen.has(parent)) {
        out.push({ id: `node:${id}#cycle`, kind: 'combination', key: `node:${id}`, label: labelOf(located.value, 'a boundary'), ours: null, theirs: null, description: 'Together, the two sides put this boundary inside itself.' });
        break;
      }
      seen.add(parent);
      parent = index.nodes.get(parent)?.value.parentId;
    }
  }
  return out;
}

/** Merges several merge bases into one virtual base, or says it cannot be done without a decision. */
export function virtualBase(bases: DraftDocument[], baseOfBases: (a: number, b: number) => DraftDocument | null): { base: DraftDocument } | { unresolved: true } {
  if (bases.length === 0) return { unresolved: true };
  let current = bases[0]!;
  for (let i = 1; i < bases.length; i += 1) {
    const ancestor = baseOfBases(0, i);
    if (!ancestor) return { unresolved: true };
    const result = merge(ancestor, current, bases[i]!);
    if (result.conflicts.length > 0) return { unresolved: true };
    current = result.candidate;
  }
  return { base: current };
}

