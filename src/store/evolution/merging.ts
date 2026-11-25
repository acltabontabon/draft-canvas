/**
 * Bringing one alternative into another: the merge, as the person experiences it. The engine is
 * `evolution/merge.ts`, in the worker; this is the protocol around it (ADR-3, ADR-7).
 *
 * - Already included: nothing to do. A true fast-forward adopts the other branch's revision as the
 *   tip — no merge commit, no extra revision — journaled like any move of the working copy.
 * - Otherwise a merge session: the combined result is shown on the canvas (compare's overlay of
 *   the result against this architecture), each conflict waits for a choice, and the session is
 *   kept in the journal so an interruption loses no decision.
 * - Finishing re-checks everything it read: both branch tips, and the live diagram's content — a
 *   collaborator's newer edit is never overwritten because the branches happened not to move. Then
 *   a real two-parent commit, and the result applied as one undo step.
 */
import { historyContent, withLiveBookkeeping } from '../../document/content';
import type { DraftDocument } from '../../document/types';
import { HistoryError, type Oid } from '../../evolution/contracts';
import { randomId } from '../../evolution/hash';
import { operationRecord } from '../../evolution/journal';
import { virtualBase, type Side } from '../../evolution/merge';
import { branchOf, mergeSessionRef } from '../../evolution/refs';
import { formatMessage } from '../../evolution/trailers';
import { isSharedEditing } from '../collabStore';
import { fileOf, isInteracting, useEditorStore } from '../editorStore';
import { useUiStore } from '../uiStore';
import { historyService, historySignature } from './bridge';
import { historyCompute } from './client';
import { useEvolutionStore, type MergeSession } from './evolutionStore';
import { closeLens, loadTimeline, snapshotOf } from './historyView';
import type { Outcome } from './operations';

const SESSION = 'merge-session';

function nameOf(altId: string | null): string {
  if (altId === null) return 'Main architecture';
  return historyService().context()?.meta?.alternatives.find((alt) => alt.altId === altId)?.name ?? 'Alternative';
}

function refused(message: string): Outcome {
  return { ok: false, message };
}

/** Shows the session's result on the canvas, marked against this architecture. */
async function preview(session: MergeSession): Promise<void> {
  const diff = await historyCompute().diff(session.oursFile, session.result.candidate);
  const lens = useEvolutionStore.getState().lens;
  useEvolutionStore.setState({
    timelineOpen: true,
    merge: session,
    compare: {
      base: { oid: session.ours, label: session.into.name, file: session.oursFile },
      target: { oid: 'merge', label: `With “${session.source.name}”`, file: session.result.candidate },
      diff,
      mode: 'overlay',
      side: 'after',
      structuralOnly: false,
      focused: null,
    },
    lens: { oid: 'merge', file: session.result.candidate, previous: lens?.file ?? null, path: lens?.path ?? useEditorStore.getState().path, step: (lens?.step ?? 0) + 1, missing: null },
  });
  useUiStore.getState().setHistoryLens(true);
}

/** Brings the alternative `source` into the one being worked on. */
export async function startMerge(source: string | null, resume?: { opId: string; choices: Record<string, Side> }): Promise<Outcome> {
  if (isSharedEditing()) return refused('Merging during a live session would change everyone’s diagram at once. End the session first.');
  try {
    const service = historyService();
    await service.flush();
    const context = service.context();
    if (!context?.store || context.readOnly) throw new HistoryError('unavailable', 'History is read-only here.');
    if (isInteracting()) throw new HistoryError('locked', 'Finish what you are dragging first.');
    const store = context.store;
    const into = context.binding?.altId ?? null;
    if (into === source) return refused('That is the architecture you are on.');
    const ours = context.tip;
    const theirs = await store.readRef(branchOf(source));
    if (!ours || !theirs) return refused('Both need at least one revision to be merged.');
    if (ours === theirs || (await store.isAncestor(theirs, ours))) return { ok: true, message: `Everything in “${nameOf(source)}” is already here.` };

    const live = fileOf(useEditorStore.getState());
    const compute = historyCompute();
    if (await store.isAncestor(ours, theirs)) return fastForward(theirs, source);

    const bases = await store.mergeBases(ours, theirs);
    if (bases.length === 0) return refused('These two have no history in common, so they cannot be merged.');
    let base: DraftDocument;
    if (bases.length === 1) {
      base = await snapshotOf(bases[0]!);
    } else {
      // Several common ancestors (criss-crossed merges): fold them into one, or stop and say so.
      const docs = await Promise.all(bases.map(snapshotOf));
      const pairBases = await Promise.all(bases.slice(1).map((other) => store.mergeBases(bases[0]!, other)));
      const ancestors = await Promise.all(pairBases.map((list) => (list.length === 1 ? snapshotOf(list[0]!) : Promise.resolve(null))));
      const folded = virtualBase(docs, (_a, b) => ancestors[b - 1] ?? null);
      if ('unresolved' in folded) {
        return refused(`These two share ${bases.length} separate ancestors that cannot be combined automatically. Merge them step by step: bring each one up to date with the main architecture first.`);
      }
      base = folded.base;
    }
    const [oursFile, theirsFile] = await Promise.all([snapshotOf(ours), snapshotOf(theirs)]);
    const choices = resume?.choices ?? {};
    const result = await compute.merge(base, oursFile, theirsFile, Object.entries(choices));
    const oursBlob = (await compute.prepare(live)).blobId;
    const opId = resume?.opId ?? randomId('m');
    const session: MergeSession = {
      opId,
      source: { altId: source, name: nameOf(source) },
      into: { altId: into, name: nameOf(into) },
      ours,
      theirs,
      base,
      oursFile,
      theirsFile,
      result,
      choices,
      revision: useEditorStore.getState().revision,
      oursBlob,
    };
    if (!resume) {
      // Kept until finished or cancelled: the decisions survive a restart, and the objects a ref.
      await store.updateRef({ ref: mergeSessionRef(opId, 'theirs'), expected: null, next: theirs });
      await store.journalPut({ opId, kind: SESSION, step: 'prepared', at: Date.now(), data: { source, ours, theirs, choices } });
    }
    await preview(session);
    return { ok: true };
  } catch (error) {
    return refused(error instanceof Error ? error.message : 'The merge could not start.');
  }
}

/** The other branch is simply further along: adopt its revision as this one's tip. */
async function fastForward(theirs: Oid, source: string | null): Promise<Outcome> {
  const service = historyService();
  const context = service.context()!;
  const store = context.store!;
  const ref = branchOf(context.binding?.altId ?? null);
  const live = fileOf(useEditorStore.getState());
  const expectedRevision = useEditorStore.getState().revision;
  const target = withLiveBookkeeping(await snapshotOf(theirs), live);
  const compute = historyCompute();
  const [before, after] = await Promise.all([compute.prepare(live), compute.prepare(target)]);
  const opId = randomId('o');
  const data = { repoId: store.repoId, copyId: context.copyId, sessionId: String(service.current ?? ''), pointer: { kind: 'ref' as const, ref, from: context.tip, to: theirs }, workingBefore: before.blobId, workingAfter: after.blobId, target: theirs };
  await store.journalPut(operationRecord(opId, 'fast-forward', 'prepared', data, Date.now()));
  const moved = await store.updateRef({ ref, expected: context.tip, next: theirs });
  if (!moved.ok) {
    await store.journalDelete(opId);
    return refused('History changed elsewhere meanwhile; try again.');
  }
  await store.journalPut(operationRecord(opId, 'fast-forward', 'pointer-moved', data, Date.now()));
  closeLens();
  if (!useEditorStore.getState().applyToFile(`Bring in “${nameOf(source)}”`, () => target, expectedRevision)) {
    useEvolutionStore.setState({ unfinished: { opId, kind: 'fast-forward', reason: 'The diagram changed while bringing that in. Its revisions are in history; nothing on the canvas was replaced.' } });
    await service.adopt(context.token, { tip: theirs });
    return refused('The diagram changed meanwhile, so nothing on the canvas was replaced.');
  }
  await store.journalDelete(opId);
  await service.adopt(context.token, { tip: theirs });
  void loadTimeline();
  return { ok: true, message: `Brought in “${nameOf(source)}”. It was simply ahead, so no merge was needed.` };
}

/** Chooses a side for one conflict, and works the result out again. */
export async function chooseConflict(id: string, side: Side): Promise<void> {
  const session = useEvolutionStore.getState().merge;
  if (!session) return;
  const choices = { ...session.choices, [id]: side };
  const result = await historyCompute().merge(session.base, session.oursFile, session.theirsFile, Object.entries(choices));
  const next = { ...session, choices, result };
  await preview(next);
  const store = historyService().store;
  await store?.journalPut({ opId: session.opId, kind: SESSION, step: 'prepared', at: Date.now(), data: { source: session.source.altId, ours: session.ours, theirs: session.theirs, choices } }).catch(() => undefined);
}

/** Every conflict has a choice. */
export function mergeReady(session: MergeSession): boolean {
  return session.result.conflicts.every((conflict) => session.choices[conflict.id] !== undefined);
}

/** Records the merge and puts the result on the canvas, if nothing it read has moved since. */
export async function finishMerge(): Promise<Outcome> {
  const session = useEvolutionStore.getState().merge;
  if (!session) return { ok: true };
  if (!mergeReady(session)) return refused('Choose a side for every difference first.');
  try {
    const service = historyService();
    const context = service.context();
    if (!context?.store) throw new HistoryError('unavailable', 'History is not available.');
    const store = context.store;
    const ref = branchOf(session.into.altId);
    const compute = historyCompute();
    const live = fileOf(useEditorStore.getState());
    const [ourTip, theirTip, now] = await Promise.all([store.readRef(ref), store.readRef(branchOf(session.source.altId)), compute.prepare(live)]);
    if (ourTip !== session.ours || theirTip !== session.theirs || now.blobId !== session.oursBlob) {
      return refused('Something changed since this merge began. Start it again to include the latest of both.');
    }
    const merged = withLiveBookkeeping(session.result.candidate, live);
    const prepared = await compute.prepare(merged);
    const described = await compute.describe(session.oursFile, historyContent(merged));
    const signature = historySignature(Date.now());
    const commit = await store.writeSnapshot({
      text: prepared.text,
      parents: [session.ours, session.theirs],
      author: signature,
      committer: signature,
      message: formatMessage({
        summary: `Merge “${session.source.name}” into ${session.into.name === 'Main architecture' ? 'the main architecture' : `“${session.into.name}”`}`,
        body: described.body,
        trailers: { initiator: 'merge', documentId: live.metadata.id, categories: described.categories, ...(session.into.altId ? { alternative: session.into.altId } : {}) },
      }),
    });
    const data = { repoId: store.repoId, copyId: context.copyId, sessionId: String(service.current ?? ''), pointer: { kind: 'ref' as const, ref, from: session.ours, to: commit }, workingBefore: now.blobId, workingAfter: prepared.blobId, target: commit };
    await store.journalPut(operationRecord(session.opId, 'merge', 'prepared', data, Date.now()));
    const moved = await store.updateRef({ ref, expected: session.ours, next: commit });
    if (!moved.ok) {
      await store.journalPut({ opId: session.opId, kind: SESSION, step: 'prepared', at: Date.now(), data: { source: session.source.altId, ours: session.ours, theirs: session.theirs, choices: session.choices } });
      return refused('History changed elsewhere meanwhile; start the merge again.');
    }
    await store.journalPut(operationRecord(session.opId, 'merge', 'pointer-moved', data, Date.now()));
    useEvolutionStore.setState({ merge: null, compare: null });
    closeLens();
    if (!useEditorStore.getState().applyToFile(`Merge “${session.source.name}”`, () => merged, session.revision)) {
      useEvolutionStore.setState({ unfinished: { opId: session.opId, kind: 'merge', reason: 'The diagram changed while merging. The merge is in history; nothing on the canvas was replaced.' } });
      await service.adopt(context.token, { tip: commit });
      return refused('The diagram changed meanwhile, so nothing on the canvas was replaced.');
    }
    await store.journalDelete(session.opId);
    await store.updateRef({ ref: mergeSessionRef(session.opId, 'theirs'), expected: session.theirs, next: null });
    await service.adopt(context.token, { tip: commit });
    void loadTimeline();
    return { ok: true, message: `Merged “${session.source.name}”. Undo takes the canvas back; both histories are kept.` };
  } catch (error) {
    return refused(error instanceof Error ? error.message : 'The merge could not be finished.');
  }
}

/** Leaves both architectures exactly as they were. */
export async function cancelMerge(): Promise<void> {
  const session = useEvolutionStore.getState().merge;
  useEvolutionStore.setState({ merge: null, compare: null });
  closeLens();
  if (!session) return;
  const store = historyService().store;
  await store?.journalDelete(session.opId).catch(() => undefined);
  await store?.updateRef({ ref: mergeSessionRef(session.opId, 'theirs'), expected: session.theirs, next: null }).catch(() => undefined);
}

/** A merge left open by a restart: offered back with every choice made so far. */
export async function resumeMergeSessions(): Promise<void> {
  const store = historyService().store;
  if (!store) return;
  const session = (await store.journalList()).find((record) => record.kind === SESSION);
  if (!session) return;
  const data = session.data as { source: string | null; ours: Oid; choices: Record<string, Side> };
  if (data.ours !== historyService().context()?.tip) {
    // This architecture moved on since: the old session's decisions no longer apply.
    await store.journalDelete(session.opId);
    return;
  }
  await startMerge(data.source, { opId: session.opId, choices: data.choices ?? {} });
}
