/**
 * Where Canvas Evolution meets the editor: the only module that subscribes to `editorStore` for
 * history, the way `collabBridge.ts` is for collaboration (AGENTS.md, "Live collaboration").
 *
 * The shells call `attachHistory` when a working copy opens and `detachHistory` when it closes;
 * the desktop shell installs its own backend first (`desktop/history.ts`). Everything else —
 * noticing edits, waiting for gesture boundaries, coalescing agent batches — happens here.
 */
import { DEFAULT_SCHEDULE, type SchedulerConfig } from '../../evolution/scheduler';
import type { HistoryBackend } from '../../evolution/backend';
import { HistoryError, type Signature } from '../../evolution/contracts';
import { copyIdOf, type CopyKey } from '../../evolution/identity';
import { randomId } from '../../evolution/hash';
import { copyLock } from '../../evolution/locks';
import { readPreference, writePreference } from '../../lib/preferences';
import { useCollabStore } from '../collabStore';
import { documentLoadCount, fileOf, isInteracting, useEditorStore } from '../editorStore';
import { useUiStore } from '../uiStore';
import { browserHistoryBackend, historyCompute, historyWorkerComputesOnly } from './client';
import { useEvolutionStore } from './evolutionStore';
import { HistoryService, type Attribution } from './service';

/** Preference keys (`lib/preferences.ts`): device-wide, tiny, never diagram content. */
export const HISTORY_PREFS = {
  enabled: 'history',
  idle: 'history-idle',
  max: 'history-max',
  note: 'history-note',
  name: 'history-name',
  email: 'history-email',
  /** Agents may read past revisions' whole content (off by default: history can hold removed content). */
  agentsRead: 'history-agents-read',
} as const;

export function historyEnabled(): boolean {
  return readPreference(HISTORY_PREFS.enabled) !== 'off';
}

function seconds(key: string, fallback: number, min: number, max: number): number {
  const value = Number(readPreference(key));
  return Number.isFinite(value) && value >= min && value <= max ? value * 1000 : fallback;
}

export function historySchedule(): SchedulerConfig {
  const idleMs = seconds(HISTORY_PREFS.idle, DEFAULT_SCHEDULE.idleMs, 5, 3600);
  const maxMs = Math.max(idleMs, seconds(HISTORY_PREFS.max, DEFAULT_SCHEDULE.maxMs, 10, 7200));
  return { ...DEFAULT_SCHEDULE, idleMs, maxMs };
}

/**
 * Who a revision names. The person's own Git identity when they set one in Settings → History;
 * otherwise this device, said plainly — never a made-up person.
 */
export function historySignature(at: number): Signature {
  const name = readPreference(HISTORY_PREFS.name)?.trim() || 'Draft Canvas';
  const email = readPreference(HISTORY_PREFS.email)?.trim() || 'history@draftcanvas.invalid';
  return { name, email, timestamp: Math.floor(at / 1000), timezoneOffset: new Date(at).getTimezoneOffset() };
}

interface LockManagerLike {
  request(name: string, options: { mode: 'exclusive'; ifAvailable: true }, run: (lock: unknown) => Promise<void> | void): Promise<void>;
}

/**
 * Holds the copy's lock for as long as history records it here. Another tab with the same diagram
 * finds it taken and shows history read-only; a tab that closes or crashes lets it go.
 */
async function holdCopy(copyId: string): Promise<(() => void) | null> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  if (!locks) throw new HistoryError('unavailable', 'This browser cannot keep history safe across tabs, so history is off here.');
  return new Promise((resolve) => {
    void locks.request(copyLock(copyId), { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return;
      }
      return new Promise<void>((release) => resolve(() => release()));
    });
  });
}

let backendFactory: () => HistoryBackend = browserHistoryBackend;
let attribution: ((changedKeys: string[]) => Attribution) | undefined;
let service: HistoryService | null = null;
let unsubscribe: (() => void) | null = null;
let agentTimer: ReturnType<typeof setTimeout> | null = null;

/** The desktop shell keeps histories itself: called once at startup, before any document opens. */
export function installHistoryBackend(factory: () => HistoryBackend, copyKey?: () => CopyKey | null): void {
  historyWorkerComputesOnly();
  backendFactory = factory;
  hostCopyKeyOf = copyKey ?? null;
}

let hostCopyKeyOf: (() => CopyKey | null) | null = null;

/** The working copy a host shell has open (the desktop's file or draft), when a shell says. */
export function hostCopyKey(): CopyKey | null {
  return hostCopyKeyOf?.() ?? null;
}

/**
 * The same working copy under a new identity: a Quick Draft saved to a file, a file renamed or
 * moved from inside the app. Its history goes with it; nothing is recorded or lost.
 */
export async function rebindHistoryCopy(from: CopyKey, to: CopyKey): Promise<void> {
  const fromId = copyIdOf(from);
  const toId = copyIdOf(to);
  if (fromId === toId) return;
  const backend = backendFactory();
  // A first capture may still be on its way: let it finish so its binding moves too.
  if (useEvolutionStore.getState().copyId === fromId) await service?.flush().catch(() => undefined);
  const binding = await backend.binding(fromId);
  if (!binding) {
    if (useEvolutionStore.getState().copyId === fromId) await attachHistory(to);
    return;
  }
  await backend.putBinding({ ...binding, copyId: toId, at: Date.now() });
  await backend.deleteBinding(fromId);
  if (useEvolutionStore.getState().copyId === fromId) await attachHistory(to);
}

/**
 * "Duplicate with history": the copy gets a history of its own — every revision, alternative and
 * milestone of the original, copied through a standard bundle into a new repository that records
 * where it came from (`lineage`). The two never share a branch afterwards. Returns whether the
 * original had any history to copy.
 */
export async function duplicateHistory(from: CopyKey, to: CopyKey, copy: { documentId: string; title: string }): Promise<boolean> {
  const backend = backendFactory();
  const source = await backend.binding(copyIdOf(from));
  if (!source) return false;
  const store = await backend.open(source.repoId);
  if (!store) return false;
  const refs = [...(await store.listRefs('refs/heads')), ...(await store.listRefs('refs/tags/milestone'))];
  const main = refs.find((entry) => entry.ref === 'refs/heads/main');
  if (!main) return false;
  const original = await store.meta();
  const bytes = await backend.exportBundle(source.repoId, refs);
  const repoId = randomId('r');
  const imported = await backend.importBundle(bytes, {
    repoId,
    documentId: copy.documentId,
    title: copy.title,
    createdAt: Date.now(),
    alternatives: original.alternatives,
    lineage: { repoId: source.repoId, oid: main.oid },
  });
  const created = await backend.open(imported.repoId);
  if (created) await created.writeMeta({ ...(await created.meta()), documentId: copy.documentId, title: copy.title, alternatives: original.alternatives, lineage: { repoId: source.repoId, oid: main.oid } });
  await backend.putBinding({ copyId: copyIdOf(to), repoId: imported.repoId, altId: source.altId, documentId: copy.documentId, lastSeen: null, at: Date.now() });
  return true;
}

/** Whether a working copy has history on this device. */
export async function hasHistory(key: CopyKey): Promise<boolean> {
  return (await backendFactory().binding(copyIdOf(key))) !== undefined;
}

/** Collaboration reports who contributed to what will be captured (`collabBridge.ts`). */
export function setHistoryAttribution(source: ((changedKeys: string[]) => Attribution) | undefined): void {
  attribution = source;
}

export function historyService(): HistoryService {
  service ??= new HistoryService({
    backend: () => backendFactory(),
    compute: historyCompute(),
    editor: {
      file: () => fileOf(useEditorStore.getState()),
      generation: () => useEditorStore.getState().revision,
      atBoundary: () => !isInteracting(),
      // A share link's read-only copy and a guest's copy of someone else's session are never this
      // device's to record, whatever id they carry.
      recordable: () => !useUiStore.getState().readOnly && useCollabStore.getState().role !== 'guest',
    },
    clock: { now: () => Date.now(), setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    schedule: historySchedule,
    enabled: historyEnabled,
    signature: historySignature,
    holdCopy,
    attribution: (keys) => attribution?.(keys) ?? { contributors: [], agents: [] },
    firstUseSeen: () => readPreference(HISTORY_PREFS.note) === 'seen',
  });
  return service;
}

/**
 * While an outside change is on its way into the editor (`noteExternalChange`): the load count it
 * was reported at. The first load after it is that change, and the one labelled `external`.
 */
let externalAfterLoad: number | null = null;

function listen(documentId: string): void {
  unsubscribe?.();
  externalAfterLoad = null;
  let loads = documentLoadCount('all');
  unsubscribe = useEditorStore.subscribe((state, previous) => {
    if (state.revision === previous.revision) return;
    const loaded = documentLoadCount('all');
    const external = externalAfterLoad !== null && loaded > externalAfterLoad;
    if (external) externalAfterLoad = null;
    // Another file opened in this window under the same id (a duplicate made outside the app): the
    // shell's working copy changed, so history follows it rather than the id.
    if (loaded !== loads) {
      loads = loaded;
      const key = hostCopyKey();
      if (key && copyIdOf(key) !== useEvolutionStore.getState().copyId) {
        void attachHistory(key);
        return;
      }
    }
    if (state.document.metadata.id !== documentId) return;
    historyService().noteEdit();
    if (external) historyService().requestCapture('external');
  });
}

/** A working copy opened in the editor: record its history from now on. */
export async function attachHistory(key: CopyKey, options: { readOnly?: boolean } = {}): Promise<void> {
  const documentId = useEditorStore.getState().document.metadata.id;
  listen(documentId);
  watchVisibility();
  // A lens open on the previous diagram's history closes with it.
  useUiStore.getState().setHistoryLens(false);
  await historyService().attach(key, options);
  // Anything a crash left half done for this copy is finished, dropped or asked about (ADR-3).
  void import('./operations')
    .then((operations) => operations.recoverOperations())
    .then(() => import('./merging'))
    .then((merging) => merging.resumeMergeSessions())
    .catch(() => undefined);
}

let watchingVisibility = false;

/** Leaving the page is a lifecycle edge: record what is pending, at the next boundary, if there is time. */
function watchVisibility(): void {
  if (watchingVisibility || typeof document === 'undefined') return;
  watchingVisibility = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') service?.requestCapture('auto');
  });
}

/**
 * The working copy is closing: record what is pending (when it can), then stop. Given a copy, only
 * if that copy is still the one attached — a late close never detaches the diagram opened after it.
 */
export async function detachHistory(key?: CopyKey): Promise<void> {
  if (key && useEvolutionStore.getState().copyId !== copyIdOf(key)) return;
  await detachNow();
}

/**
 * The diagram with this id is closing: detach if it is the one attached. By document, not by copy
 * key, so a copy rebound while open (a draft saved to a file) is still let go when it closes.
 */
export async function detachHistoryFor(documentId: string): Promise<void> {
  if (service?.documentId !== documentId) return;
  await detachNow();
}

async function detachNow(): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
  externalAfterLoad = null;
  await service?.detach();
  // Detaching took the lens away (the evolution store is reset), so the edit lock it held goes too.
  // Only `attachHistory` once cleared it, and a guest's or share link's copy never attaches: a past
  // revision on screen as the person joined a session left the canvas refusing every edit, with
  // nothing on screen saying why. Not when a lens is up again: it belongs to a diagram opened since.
  if (!useEvolutionStore.getState().lens) useUiStore.getState().setHistoryLens(false);
}

/**
 * An agent's reviewed change just landed. Its batch is recorded as one revision once the agent has
 * been quiet for a moment, not one per write.
 */
export function noteAgentCommit(agent: string): void {
  const history = service;
  if (!history) return;
  history.noteEdit(agent);
  if (agentTimer) clearTimeout(agentTimer);
  agentTimer = setTimeout(() => {
    agentTimer = null;
    history.agentSettled();
  }, historySchedule().agentQuietMs);
}

/**
 * The file changed outside the app and was reloaded: what is on disk now becomes its own revision,
 * marked as coming from outside (`initiator: external`), not as the person's own drawing.
 *
 * The shell has only posted the reload when it calls this; the editor takes it in later (the host
 * hook awaits a save and an open first). Capturing at once snapshotted the diagram from before the
 * reload, so edits of the person's own not yet recorded went in labelled `external`, and the outside
 * change after them as `auto`. Now what the editor holds is recorded first under its own label, and
 * the `external` capture waits for the load that brings the change in (`listen`).
 */
export function noteExternalChange(): void {
  const history = service;
  if (!history) return;
  history.requestCapture('auto');
  externalAfterLoad = documentLoadCount('all');
}

/** "Capture now" from the status, the palette or a lifecycle edge. */
export function captureNow(): void {
  service?.requestCapture('manual');
}

/** The first-use note was read: never shown again on this device. */
export function dismissHistoryNote(): void {
  writePreference(HISTORY_PREFS.note, 'seen');
  useEvolutionStore.setState({ firstUse: false });
}
