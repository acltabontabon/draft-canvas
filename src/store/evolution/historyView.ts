/**
 * Reading history for the timeline and the lens: revisions in pages, milestones, and past
 * revisions as documents, through a small bounded cache.
 *
 * Viewing never changes the working copy. The lens holds its own copy of a past revision and the
 * editor refuses edits while it is up (`editorStore`'s `editingLocked`); the live diagram keeps
 * receiving changes from elsewhere underneath, and is exactly as it was when the lens closes.
 */
import type { DepthPath } from '../../depth/tree';
import { ROOT_PATH, viewOf } from '../../depth/tree';
import type { DraftDocument } from '../../document/types';
import { HistoryError, type Oid } from '../../evolution/contracts';
import { randomId } from '../../evolution/hash';
import { branchOf, milestoneRef, MILESTONE_PREFIX } from '../../evolution/refs';
import { milestoneMessage, toMilestone, toRevision, type Milestone, type Revision } from '../../evolution/timeline';
import { fileOf, useEditorStore } from '../editorStore';
import { useUiStore } from '../uiStore';
import { historyCompute } from './client';
import { historyService, historySignature } from './bridge';
import { useEvolutionStore } from './evolutionStore';

const PAGE = 200;
const CACHE_LIMIT = 16;

/** Parsed revisions by id, least recently used first. Bounded: scrubbing a long history never holds them all. */
const snapshots = new Map<Oid, DraftDocument>();
let cacheRepo: string | null = null;

function remember(oid: Oid, document: DraftDocument): void {
  snapshots.delete(oid);
  snapshots.set(oid, document);
  while (snapshots.size > CACHE_LIMIT) snapshots.delete(snapshots.keys().next().value!);
}

/** A past revision as a document (its history content). */
export async function snapshotOf(oid: Oid): Promise<DraftDocument> {
  const store = historyService().store;
  if (!store) throw new HistoryError('unavailable', 'This diagram has no history yet.');
  if (cacheRepo !== store.repoId) {
    snapshots.clear();
    cacheRepo = store.repoId;
  }
  const cached = snapshots.get(oid);
  if (cached) {
    remember(oid, cached);
    return cached;
  }
  const parsed = await historyCompute().parse(await store.readSnapshot(oid));
  remember(oid, parsed.document);
  return parsed.document;
}

async function milestones(): Promise<Milestone[]> {
  const store = historyService().store;
  if (!store) return [];
  return (await store.listTags(MILESTONE_PREFIX)).map(toMilestone).filter((milestone): milestone is Milestone => milestone !== null);
}

/** Loads (or reloads) the newest page of the current alternative's revisions. */
export async function loadTimeline(more = false): Promise<void> {
  const token = historyService().current;
  const current = () => historyService().current === token;
  const store = historyService().store;
  const binding = historyService().binding;
  const state = useEvolutionStore.getState();
  if (!store) {
    useEvolutionStore.setState({ timeline: { ...state.timeline, revisions: [], loading: false, more: false, error: null } });
    return;
  }
  useEvolutionStore.setState({ timeline: { ...state.timeline, loading: true, error: null } });
  try {
    const tip = await store.readRef(branchOf(binding?.altId ?? null));
    if (!tip) {
      useEvolutionStore.setState((s) => ({ timeline: { ...s.timeline, revisions: [], loading: false, more: false } }));
      return;
    }
    const loaded = useEvolutionStore.getState().timeline.revisions;
    const known = more ? loaded : [];
    // Earlier pages continue from every parent not yet listed — after a merge, both sides.
    const listed = new Set(known.map((revision) => revision.oid));
    const from = more ? [...new Set(known.flatMap((revision) => revision.parents))].filter((oid) => !listed.has(oid)) : [tip];
    const marks = await milestones();
    // A reload keeps as many revisions as were showing, so a new one never throws earlier pages away.
    const limit = more ? PAGE : Math.min(500, Math.max(PAGE, loaded.length + 1));
    const commits = from.length > 0 ? await store.log({ from, limit, hide: [] }) : [];
    if (!current()) return;
    const revisions = [...known, ...commits.filter((commit) => !listed.has(commit.oid)).map((commit) => toRevision(commit, marks))];
    useEvolutionStore.setState((s) => ({ timeline: { ...s.timeline, revisions, loading: false, more: commits.length === limit } }));
  } catch (error) {
    useEvolutionStore.setState((s) => ({ timeline: { ...s.timeline, loading: false, error: error instanceof Error ? error.message : 'History could not be read.' } }));
  }
}

function setLens(file: DraftDocument, oid: Oid | 'live', path: DepthPath): void {
  const current = useEvolutionStore.getState().lens;
  const previous = current?.file ?? fileOf(useEditorStore.getState());
  // Stay in the same room when the revision has it; otherwise its nearest room that does.
  let room = path;
  while (room.length > 0 && !viewOf(file, room)) room = room.slice(0, -1);
  useEvolutionStore.setState({
    lens: { oid, file, previous, path: room, step: (current?.step ?? 0) + 1, missing: room.length < path.length ? 'That view is not in this revision.' : null },
  });
  useUiStore.getState().setHistoryLens(oid !== 'live');
}

/** The newest request to show something: an older one finishing late is dropped, never shown. */
let showing = 0;

/** Shows a past revision in the lens, in the room being looked at. */
export async function showRevision(oid: Oid): Promise<void> {
  const request = ++showing;
  const token = historyService().current;
  const file = await snapshotOf(oid);
  if (request !== showing || historyService().current !== token) return;
  const current = useEvolutionStore.getState().lens;
  const path = current?.path ?? useEditorStore.getState().path;
  setLens(file, oid, path);
}

/** Returns to the live diagram: eases the lens to what is live now, then closes it. */
export function showLive(): void {
  showing += 1;
  const lens = useEvolutionStore.getState().lens;
  if (!lens) return;
  setLens(fileOf(useEditorStore.getState()), 'live', lens.path);
}

/** Closes the lens at once (the transition to live finished, or there is nothing to ease). */
export function closeLens(): void {
  if (!useEvolutionStore.getState().lens && !useUiStore.getState().historyLens) return;
  useEvolutionStore.setState((state) => ({ lens: null, playback: { ...state.playback, playing: false } }));
  useUiStore.getState().setHistoryLens(false);
}

/** Moves the lens into (or out of) a room of the revision it shows. */
export function lensEnter(path: DepthPath): void {
  const lens = useEvolutionStore.getState().lens;
  if (!lens || lens.oid === 'live') return;
  if (path.length > 0 && !viewOf(lens.file, path)) {
    useEvolutionStore.setState({ lens: { ...lens, missing: 'That view is not in this revision.' } });
    return;
  }
  useEvolutionStore.setState({ lens: { ...lens, path, previous: null, step: lens.step + 1, missing: null } });
}

export const lensRoot = (): void => lensEnter(ROOT_PATH);

/**
 * One step along the timeline: `-1` is older, `+1` newer, and past the newest is live.
 * Returns whether it moved.
 */
export async function stepRevision(delta: -1 | 1): Promise<boolean> {
  const { lens, timeline } = useEvolutionStore.getState();
  const list = timeline.revisions;
  if (list.length === 0) return false;
  if (!lens || lens.oid === 'live') {
    if (delta === 1) return false;
    await showRevision(list[0]!.oid);
    return true;
  }
  const index = list.findIndex((revision) => revision.oid === lens.oid);
  const next = index - delta;
  if (next < 0) {
    showLive();
    return true;
  }
  const target = list[next];
  if (!target) return false;
  await showRevision(target.oid);
  return true;
}

/** Names a revision as a milestone: an annotated Git tag, so history itself is never rewritten. */
export async function addMilestone(oid: Oid, name: string, note = ''): Promise<void> {
  const store = historyService().store;
  if (!store) throw new HistoryError('unavailable', 'This diagram has no history yet.');
  // Only a revision this history has: a tag naming anything else would break export and maintenance.
  await store.readCommit(oid);
  const id = randomId('m');
  await store.writeTag({ ref: milestoneRef(id), name: `milestone/${id}`, target: oid, tagger: historySignature(Date.now()), message: milestoneMessage(name, note) });
  useEvolutionStore.setState((state) => ({ changes: state.changes + 1 }));
  await loadTimeline();
}

const summaries = new Map<string, Promise<string>>();

/**
 * A session's net change in one line — from the revision before it to its last — computed once per
 * session in the worker. Cumulative churn (added, then removed) is not in it.
 */
export function sessionSummary(before: Oid | null, last: Oid): Promise<string> {
  const key = `${before ?? 'start'}..${last}`;
  let known = summaries.get(key);
  if (!known) {
    known = (async () => {
      const [from, to] = await Promise.all([before ? snapshotOf(before) : Promise.resolve(null), snapshotOf(last)]);
      return (await historyCompute().describe(from, to)).summary;
    })().catch(() => '');
    summaries.set(key, known);
    if (summaries.size > 200) summaries.delete(summaries.keys().next().value!);
  }
  return known;
}

/** The revisions newer than `oid` up to live, oldest first, for playback from there. */
export function revisionsAfter(oid: Oid): Revision[] {
  const list = useEvolutionStore.getState().timeline.revisions;
  const index = list.findIndex((revision) => revision.oid === oid);
  return index <= 0 ? [] : list.slice(0, index).reverse();
}
