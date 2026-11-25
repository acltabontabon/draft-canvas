/**
 * Comparing two versions of the diagram on the canvas: any two revisions, or a revision and the
 * diagram as it is now. Read-only, like the lens it is drawn in: nothing here changes the working
 * copy. The semantic diff is the one engine (`evolution/diff.ts`), worked out in the history worker.
 */
import { ROOT_ROOM } from '../../collab/changes';
import { roomsOf, ROOT_PATH, type DepthPath } from '../../depth/tree';
import { historyContent } from '../../document/content';
import type { DraftDocument } from '../../document/types';
import type { Oid } from '../../evolution/contracts';
import { STRUCTURAL, type ElementChange } from '../../evolution/diff';
import { fileOf, useEditorStore } from '../editorStore';
import { useUiStore } from '../uiStore';
import { historyCompute } from './client';
import { useEvolutionStore, type CompareSide, type CompareState } from './evolutionStore';
import { showLive, showRevision, snapshotOf } from './historyView';

async function sideOf(oid: Oid | 'now'): Promise<CompareSide> {
  if (oid === 'now') return { oid, label: 'Now', file: historyContent(fileOf(useEditorStore.getState())) };
  const revision = useEvolutionStore.getState().timeline.revisions.find((candidate) => candidate.oid === oid);
  return { oid, label: revision?.summary ?? oid.slice(0, 8), file: await snapshotOf(oid) };
}

/** The position of a side in time: revisions by their place in the timeline, now after all of them. */
function age(oid: Oid | 'now'): number {
  if (oid === 'now') return Number.POSITIVE_INFINITY;
  const list = useEvolutionStore.getState().timeline.revisions;
  const index = list.findIndex((revision) => revision.oid === oid);
  return index < 0 ? -1 : list.length - index;
}

let comparing = 0;

/** Compares two versions, the older drawn as "before" and the newer as "after". */
export async function compareVersions(a: Oid | 'now', b: Oid | 'now'): Promise<void> {
  if (a === b) return;
  const request = ++comparing;
  const [older, newer] = age(a) <= age(b) ? [a, b] : [b, a];
  const [base, target] = await Promise.all([sideOf(older), sideOf(newer)]);
  const diff = await historyCompute().diff(base.file, target.file);
  if (request !== comparing) return;
  const previous = useEvolutionStore.getState().compare;
  const compare: CompareState = {
    base,
    target,
    diff,
    mode: previous?.mode ?? 'overlay',
    side: 'after',
    structuralOnly: previous?.structuralOnly ?? false,
    focused: null,
  };
  useEvolutionStore.setState({ compare, playback: { ...useEvolutionStore.getState().playback, playing: false } });
  drawSide(compare);
}

/** Puts the side being looked at into the lens. */
function drawSide(compare: CompareState): void {
  const side = compare.side === 'after' ? compare.target : compare.base;
  const lens = useEvolutionStore.getState().lens;
  useEvolutionStore.setState({
    lens: {
      oid: side.oid,
      file: side.file,
      previous: lens?.file ?? null,
      path: lens?.path ?? useEditorStore.getState().path,
      step: (lens?.step ?? 0) + 1,
      missing: null,
    },
  });
  useUiStore.getState().setHistoryLens(true);
}

export function setCompare(patch: Partial<Pick<CompareState, 'mode' | 'side' | 'structuralOnly'>>): void {
  const compare = useEvolutionStore.getState().compare;
  if (!compare) return;
  const next = { ...compare, ...patch };
  useEvolutionStore.setState({ compare: next });
  if (patch.side && patch.side !== compare.side) drawSide(next);
}

/** Ends the comparison, back to the later revision on its own — or to the live diagram. */
export function endCompare(): void {
  const compare = useEvolutionStore.getState().compare;
  comparing += 1;
  useEvolutionStore.setState({ compare: null });
  if (!compare || compare.target.oid === 'now') showLive();
  else void showRevision(compare.target.oid);
}

/** The changes the list and the overlay show, after the structural filter. */
export function visibleChanges(compare: CompareState): ElementChange[] {
  if (!compare.structuralOnly) return compare.diff.elements;
  return compare.diff.elements.filter((change) => change.change !== 'modified' || change.categories.some((category) => STRUCTURAL.has(category)));
}

/** The path to a room, found by the id of the shape that owns it. */
function pathOfRoom(file: DraftDocument, room: string): DepthPath | null {
  if (room === ROOT_ROOM) return ROOT_PATH;
  return roomsOf(file).find((candidate) => candidate.path[candidate.path.length - 1] === room)?.path ?? null;
}

/**
 * Takes the lens to a change: into its room if it is in another, then the camera to it
 * (`HistoryLens` frames `compare.focused`).
 */
export function focusChange(change: ElementChange): void {
  const { compare, lens } = useEvolutionStore.getState();
  if (!compare || !lens) return;
  const file = change.change === 'removed' ? compare.base.file : compare.target.file;
  const path = pathOfRoom(file, change.room) ?? lens.path;
  const sameRoom = path.join('/') === lens.path.join('/');
  useEvolutionStore.setState({
    compare: { ...compare, focused: `${change.kind}:${change.id}` },
    ...(sameRoom ? {} : { lens: { ...lens, path, previous: null, step: lens.step + 1, missing: null } }),
  });
}
