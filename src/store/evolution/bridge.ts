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
import { copyLock } from '../../evolution/locks';
import { readPreference, writePreference } from '../../lib/preferences';
import { fileOf, isInteracting, useEditorStore } from '../editorStore';
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
let attribution: (() => Attribution) | undefined;
let service: HistoryService | null = null;
let unsubscribe: (() => void) | null = null;
let agentTimer: ReturnType<typeof setTimeout> | null = null;

/** The desktop shell keeps histories itself: called once at startup, before any document opens. */
export function installHistoryBackend(factory: () => HistoryBackend): void {
  historyWorkerComputesOnly();
  backendFactory = factory;
}

/** Collaboration reports who contributed to what will be captured (`collabBridge.ts`). */
export function setHistoryAttribution(source: (() => Attribution) | undefined): void {
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
    },
    clock: { now: () => Date.now(), setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    schedule: historySchedule,
    enabled: historyEnabled,
    signature: historySignature,
    holdCopy,
    attribution: () => attribution?.() ?? { contributors: [], agents: [] },
    firstUseSeen: () => readPreference(HISTORY_PREFS.note) === 'seen',
  });
  return service;
}

function listen(documentId: string): void {
  unsubscribe?.();
  unsubscribe = useEditorStore.subscribe((state, previous) => {
    if (state.revision === previous.revision) return;
    if (state.document.metadata.id !== documentId) return;
    historyService().noteEdit();
  });
}

/** A working copy opened in the editor: record its history from now on. */
export async function attachHistory(key: CopyKey, options: { readOnly?: boolean } = {}): Promise<void> {
  const documentId = useEditorStore.getState().document.metadata.id;
  listen(documentId);
  watchVisibility();
  await historyService().attach(key, options);
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
  unsubscribe?.();
  unsubscribe = null;
  await service?.detach();
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

/** "Capture now" from the status, the palette or a lifecycle edge. */
export function captureNow(): void {
  service?.requestCapture('manual');
}

/** The first-use note was read: never shown again on this device. */
export function dismissHistoryNote(): void {
  writePreference(HISTORY_PREFS.note, 'seen');
  useEvolutionStore.setState({ firstUse: false });
}
