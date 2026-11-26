/**
 * History's operations that change what the person is working on: restoring a revision (whole or in
 * part) and moving between alternatives. Each runs the recoverable protocol (`evolution/journal.ts`,
 * ADR-3): bound to the session it began in, journaled step by step, and checked against the live
 * diagram's generation before it touches it — so a collaborator's newer change is never overwritten,
 * and a crash anywhere leaves both versions recoverable.
 */
import { applyChanges } from '../../collab/apply';
import { keyOf, type Change } from '../../collab/changes';
import { diffFile } from '../../collab/diff';
import { elementsOf, indexOf } from '../../collab/fileIndex';
import { repairReferences } from '../../collab/repair';
import { historyContent, withLiveBookkeeping } from '../../document/content';
import type { DraftDocument } from '../../document/types';
import { HistoryError, type AlternativeMeta, type Oid } from '../../evolution/contracts';
import type { ElementChange } from '../../evolution/diff';
import { randomId } from '../../evolution/hash';
import { isOperation, operationRecord, recoveryFor, type Operation, type OperationData } from '../../evolution/journal';
import { archivedBranchOf, branchOf } from '../../evolution/refs';
import { formatMessage } from '../../evolution/trailers';
import { isSharedEditing } from '../collabStore';
import { fileOf, isInteracting, useEditorStore } from '../editorStore';
import { historyService, historySignature } from './bridge';
import { historyCompute } from './client';
import { useEvolutionStore } from './evolutionStore';
import { closeLens, loadTimeline, snapshotOf } from './historyView';

export type Outcome = { ok: true; message?: string } | { ok: false; message: string };

const refused = (message: string): Outcome => ({ ok: false, message });

function messageOf(error: unknown): string {
  return error instanceof HistoryError || error instanceof Error ? error.message : 'History could not complete that.';
}

/** The open session, ready for an operation: what is pending recorded first, and writable. */
async function begin() {
  const service = historyService();
  await service.flush();
  const context = service.context();
  if (!context || context.readOnly) throw new HistoryError('unavailable', 'History is read-only here.');
  if (!context.store) throw new HistoryError('unavailable', 'This diagram has no history yet.');
  if (isInteracting()) throw new HistoryError('locked', 'Finish what you are dragging first.');
  return { service, context, store: context.store };
}

function opData(context: { copyId: string }, repoId: string, pointer: OperationData['pointer'], workingBefore: string, workingAfter: string, target: Oid): OperationData {
  return { repoId, copyId: context.copyId, sessionId: String(historyService().current ?? ''), pointer, workingBefore, workingAfter, target };
}

function revisionLabel(oid: Oid): string {
  return useEvolutionStore.getState().timeline.revisions.find((revision) => revision.oid === oid)?.summary ?? `revision ${oid.slice(0, 8)}`;
}

/**
 * Restores the whole diagram to a revision, as a new revision: nothing in history is lost or
 * rewritten, and the change is one undo step. Recorded first, applied second; if the diagram changed
 * in between (a collaborator), the live diagram is left alone and the person chooses.
 */
export async function restoreRevision(oid: Oid): Promise<Outcome> {
  try {
    const { service, context, store } = await begin();
    const compute = historyCompute();
    const live = fileOf(useEditorStore.getState());
    const expectedRevision = useEditorStore.getState().revision;
    const restored = withLiveBookkeeping(await snapshotOf(oid), live);
    const [before, after] = await Promise.all([compute.prepare(live), compute.prepare(restored)]);
    if (before.blobId === after.blobId) return { ok: true, message: 'The diagram already matches that revision.' };
    const ref = branchOf(context.binding?.altId ?? null);
    const described = await compute.describe(context.tipDocument, historyContent(restored));
    const at = Date.now();
    const signature = historySignature(at);
    const label = revisionLabel(oid);
    const commit = await store.writeSnapshot({
      text: after.text,
      parents: context.tip ? [context.tip] : [],
      author: signature,
      committer: signature,
      message: formatMessage({
        summary: `Restore “${label}”`,
        body: described.body,
        trailers: { initiator: 'restore', restoredFrom: oid, documentId: live.metadata.id, categories: described.categories, ...(context.binding?.altId ? { alternative: context.binding.altId } : {}) },
      }),
    });
    const opId = randomId('o');
    const data = opData(context, store.repoId, { kind: 'ref', ref, from: context.tip, to: commit }, before.blobId, after.blobId, commit);
    await store.journalPut(operationRecord(opId, 'restore', 'prepared', data, at));
    const moved = await store.updateRef({ ref, expected: context.tip, next: commit });
    if (!moved.ok) {
      await store.journalDelete(opId);
      return refused('History changed elsewhere while restoring. Nothing was changed; try again.');
    }
    await store.journalPut(operationRecord(opId, 'restore', 'pointer-moved', data, Date.now()));
    closeLens();
    const applied = useEditorStore.getState().applyToFile(`Restore “${label}”`, () => restored, expectedRevision);
    if (!applied) {
      // Someone changed the diagram meanwhile: the restored version is safe in history, and the live
      // diagram is untouched. The person chooses (Resume / Keep current), as after a crash.
      useEvolutionStore.setState({ unfinished: { opId, kind: 'restore', reason: 'The diagram changed while restoring. The restored version is in history; nothing on the canvas was replaced.' } });
      await service.adopt(context.token, { tip: commit });
      return refused('The diagram changed while restoring, so nothing on the canvas was replaced.');
    }
    await store.journalDelete(opId);
    await service.adopt(context.token, { tip: commit });
    void loadTimeline();
    return { ok: true, message: `Restored “${label}”. Undo puts it back.` };
  } catch (error) {
    return refused(messageOf(error));
  }
}

/**
 * Brings back chosen elements from a revision — a removed shape, an earlier wording — leaving the
 * rest of the diagram as it is. What they need comes with them: the room a shape sat in, and the
 * connectors between restored shapes and shapes that still exist. One undo step.
 */
export async function restoreElements(oid: Oid, chosen: ElementChange[]): Promise<Outcome> {
  try {
    const { service } = await begin();
    const live = fileOf(useEditorStore.getState());
    const expectedRevision = useEditorStore.getState().revision;
    const historical = withLiveBookkeeping(await snapshotOf(oid), live);
    const all = diffFile(live, historical);
    const wanted = new Set(chosen.map((change) => `${change.kind}:${change.id}`));
    const nodes = new Set(chosen.filter((change) => change.kind === 'node').map((change) => change.id));
    const now = indexOf(live);
    const existing = now.nodes;
    // A shape brought back from removal brings its rooms with it. A node's change never carries its
    // `inside` (`nodeValue`); what was in its room arrives as separate changes keyed by the room, so
    // picking only the shape once restored a Service as an empty box while saying it was restored.
    // Only a shape that is gone brings its inside back: one that is still here keeps its room as it
    // is now, and an element that was moved out of the room before it went stays where it is.
    const rooms = new Set<string>();
    const roomsOf = (list: DraftDocument['nodes']) => {
      for (const node of list) {
        if (!node.inside) continue;
        rooms.add(node.id);
        roomsOf(node.inside.nodes);
      }
    };
    const then = indexOf(historical);
    for (const id of nodes) {
      const node = then.nodes.get(id)?.value;
      if (node && !existing.has(id)) roomsOf([node]);
    }
    const inRestoredRoom = (change: Change): boolean => {
      switch (change.kind) {
        case 'node':
        case 'edge':
        case 'flow':
        case 'ink':
          return rooms.has(change.room) && !elementsOf(now, change.kind).has(change.id);
        case 'level':
        case 'order':
          return rooms.has(change.room);
        default:
          return false;
      }
    };
    const picked: Change[] = [];
    for (const change of all) {
      const key = keyOf(change);
      if (wanted.has(key) || inRestoredRoom(change)) {
        picked.push(change);
        continue;
      }
      // Connectors that join a restored shape to one that is still here, or to another restored one.
      if (change.kind === 'edge' && change.value && (nodes.has(change.value.source) || nodes.has(change.value.target))) {
        const ends = [change.value.source, change.value.target];
        if (ends.every((end) => nodes.has(end) || existing.has(end))) picked.push(change);
      }
    }
    if (picked.length === 0) return refused('Those elements are already as they were.');
    const next = repairReferences(applyChanges(live, picked));
    const label = chosen.length === 1 ? `“${chosen[0]!.label}”` : `${chosen.length} elements`;
    if (!useEditorStore.getState().applyToFile(`Restore ${label}`, () => next, expectedRevision)) {
      return refused('The diagram changed meanwhile; nothing was replaced. Try again.');
    }
    service.requestCapture('restore');
    return { ok: true, message: `Restored ${label}.` };
  } catch (error) {
    return refused(messageOf(error));
  }
}

function sharedRefusal(): Outcome | null {
  return isSharedEditing() ? refused('Alternatives can’t be switched during a live session: everyone in it would change diagram. End the session first.') : null;
}

/**
 * Moves the working copy onto another alternative: what is pending is recorded on the one being
 * left, the copy's binding moves, and the diagram becomes that alternative's latest revision. A
 * change of context, not an edit: undo starts afresh, as when opening a diagram.
 */
export async function switchAlternative(altId: string | null): Promise<Outcome> {
  const shared = sharedRefusal();
  if (shared) return shared;
  try {
    const { service, context, store } = await begin();
    const fromAlt = context.binding?.altId ?? null;
    if (fromAlt === altId) return { ok: true };
    if (!context.binding) throw new HistoryError('unavailable', 'This diagram has no history yet.');
    const target = await store.readRef(branchOf(altId));
    if (!target) return refused('That alternative is no longer in this history.');
    const live = fileOf(useEditorStore.getState());
    const expectedRevision = useEditorStore.getState().revision;
    const next = withLiveBookkeeping(await snapshotOf(target), live);
    const compute = historyCompute();
    const [before, after] = await Promise.all([compute.prepare(live), compute.prepare(next)]);
    const opId = randomId('o');
    const data = opData(context, store.repoId, { kind: 'binding', copyId: context.copyId, fromAlt, toAlt: altId }, before.blobId, after.blobId, target);
    // Read again before anything moves: an edit (the person's, an agent's) or another diagram opened
    // meanwhile means this switch no longer describes what is on screen.
    const stale = () => useEditorStore.getState().revision !== expectedRevision || service.current !== context.token;
    if (stale()) return refused('The diagram changed meanwhile; nothing was switched. Try again.');
    await store.journalPut(operationRecord(opId, 'switch', 'prepared', data, Date.now()));
    const binding = { ...context.binding, altId, lastSeen: target, at: Date.now() };
    await historyService().putBindingFor(binding);
    await store.journalPut(operationRecord(opId, 'switch', 'pointer-moved', data, Date.now()));
    if (stale()) {
      // Undo the move of the binding; what is on screen stays the person's.
      await historyService().putBindingFor(context.binding);
      await store.journalDelete(opId);
      return refused('The diagram changed meanwhile; nothing was switched. Try again.');
    }
    closeLens();
    if (before.blobId !== after.blobId) useEditorStore.getState().setDocument(next, { keepPath: true });
    await store.journalDelete(opId);
    await service.adopt(context.token, { tip: target, binding });
    void loadTimeline();
    const name = altId === null ? 'the main architecture' : (context.meta?.alternatives.find((alt) => alt.altId === altId)?.name ?? 'the alternative');
    return { ok: true, message: `Now on ${name}.` };
  } catch (error) {
    return refused(messageOf(error));
  }
}

/**
 * Starts an alternative — a real Git branch — from now or from a revision, and moves onto it. The
 * architecture it leaves is safe, recorded where it was.
 */
export async function createAlternative(name: string, from?: Oid): Promise<Outcome> {
  const shared = sharedRefusal();
  if (shared) return shared;
  try {
    const { service, context, store } = await begin();
    const start = from ?? context.tip;
    if (!start) return refused('Draw something first: an alternative starts from a recorded version.');
    const altId = randomId('a');
    const created = await store.updateRef({ ref: branchOf(altId), expected: null, next: start });
    if (!created.ok) return refused('That alternative could not be created; try again.');
    const meta = await store.meta();
    const alternative: AlternativeMeta = { altId, name: name.trim().slice(0, 80) || 'Alternative', createdAt: Date.now(), from: start };
    const nextMeta = { ...meta, alternatives: [...meta.alternatives, alternative] };
    await store.writeMeta(nextMeta);
    await service.adopt(context.token, { tip: context.tip, meta: nextMeta });
    const moved = await switchAlternative(altId);
    return moved.ok ? { ok: true, message: `Exploring “${alternative.name}”. The architecture you left is unchanged.` } : moved;
  } catch (error) {
    return refused(messageOf(error));
  }
}

export async function renameAlternative(altId: string, name: string): Promise<Outcome> {
  try {
    const { service, context, store } = await begin();
    const meta = await store.meta();
    const alternatives = meta.alternatives.map((alt) => (alt.altId === altId ? { ...alt, name: name.trim().slice(0, 80) || alt.name } : alt));
    const nextMeta = { ...meta, alternatives };
    await store.writeMeta(nextMeta);
    await service.adopt(context.token, { tip: context.tip, meta: nextMeta });
    return { ok: true };
  } catch (error) {
    return refused(messageOf(error));
  }
}

/**
 * Puts an alternative away (or brings it back). Its revisions are kept, under an archive branch;
 * nothing is deleted. Archiving the one being worked on moves back to the main architecture first.
 */
export async function archiveAlternative(altId: string, archived: boolean): Promise<Outcome> {
  try {
    const { context } = await begin();
    if (archived && context.binding?.altId === altId) {
      const back = await switchAlternative(null);
      if (!back.ok) return back;
    }
    const { service, context: now, store } = await begin();
    const [from, to] = archived ? [branchOf(altId), archivedBranchOf(altId)] : [archivedBranchOf(altId), branchOf(altId)];
    const tip = await store.readRef(from);
    if (!tip) return refused('That alternative is not in this history.');
    const placed = await store.updateRef({ ref: to, expected: null, next: tip });
    if (!placed.ok) return refused('That alternative changed meanwhile; try again.');
    const removed = await store.updateRef({ ref: from, expected: tip, next: null });
    if (!removed.ok) {
      // It moved meanwhile: keep it where it is, and drop the copy just made.
      await store.updateRef({ ref: to, expected: tip, next: null });
      return refused('That alternative changed meanwhile; try again.');
    }
    const meta = await store.meta();
    const nextMeta = { ...meta, alternatives: meta.alternatives.map((alt) => (alt.altId === altId ? { ...alt, archived: archived || undefined } : alt)) };
    await store.writeMeta(nextMeta);
    await service.adopt(now.token, { tip: now.tip, meta: nextMeta });
    return { ok: true, message: archived ? 'Archived. Its revisions are kept.' : 'Back among the alternatives.' };
  } catch (error) {
    return refused(messageOf(error));
  }
}

/**
 * Looks for operations of this working copy that a crash (or a refusal) left half done, and
 * finishes, drops or asks about each, from what is actually stored (`recoveryFor`).
 */
export async function recoverOperations(): Promise<void> {
  const service = historyService();
  const context = service.context();
  if (!context?.store || context.readOnly) return;
  const store = context.store;
  const records = (await store.journalList()).filter(isOperation).filter((op) => op.data.copyId === context.copyId);
  for (const op of records) {
    const working = (await historyCompute().prepare(fileOf(useEditorStore.getState()))).blobId;
    const pointerAt =
      op.data.pointer.kind === 'ref'
        ? { kind: 'ref' as const, oid: await store.readRef(op.data.pointer.ref) }
        : { kind: 'binding' as const, altId: context.binding?.altId ?? null };
    const decision = recoveryFor(op, { pointerAt, working });
    if (decision.action === 'discard' || decision.action === 'finish') await store.journalDelete(op.opId);
    else if (decision.action === 'complete') await complete(op);
    else useEvolutionStore.setState({ unfinished: { opId: op.opId, kind: op.kind, reason: decision.reason } });
  }
}

async function complete(op: Operation): Promise<boolean> {
  const service = historyService();
  const context = service.context();
  if (!context?.store) return false;
  const live = fileOf(useEditorStore.getState());
  const target = withLiveBookkeeping(await snapshotOf(op.data.target), live);
  if (service.current !== context.token) return false;
  if (op.kind === 'switch') {
    useEditorStore.getState().setDocument(target, { keepPath: true });
  } else if (!useEditorStore.getState().applyToFile(op.kind === 'restore' ? 'Restore' : 'Finish merging', () => target)) {
    return false;
  }
  await context.store.journalDelete(op.opId);
  await service.adopt(context.token, { tip: context.tip });
  return true;
}

/** The person's answer to an unfinished operation: finish it, or keep the diagram as it is. */
export async function resolveUnfinished(resume: boolean): Promise<Outcome> {
  const unfinished = useEvolutionStore.getState().unfinished;
  const context = historyService().context();
  if (!unfinished || !context?.store) return { ok: true };
  try {
    const op = (await context.store.journalList()).filter(isOperation).find((candidate) => candidate.opId === unfinished.opId);
    if (op && resume && !(await complete(op))) return refused('The diagram is busy; try again in a moment.');
    // Keeping the current diagram: it simply becomes the next revision, on top of what was recorded.
    if (op && !resume) await context.store.journalDelete(op.opId);
    useEvolutionStore.setState({ unfinished: null });
    if (!resume) historyService().requestCapture('manual');
    return { ok: true };
  } catch (error) {
    return refused(messageOf(error));
  }
}
