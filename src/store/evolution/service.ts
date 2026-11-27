/**
 * The history service: records the open working copy's revisions in the background.
 *
 * One session per open working copy. Every asynchronous step carries its session (ADR-3): a
 * capture that finishes after the person opened another diagram, or switched alternatives, writes
 * to the history and branch it started on — by compare-and-swap from the tip it read — and then
 * leaves the editor alone. Nothing here ever changes the document; it only reads `editor.file()`.
 *
 * Failures are history's alone: drawing, undo and autosave never wait for a capture, and a capture
 * that fails is retried with backoff and shown, never dropped silently.
 */
import { historyContent } from '../../document/content';
import type { DraftDocument } from '../../document/types';
import type { HistoryBackend, ImportedHistory } from '../../evolution/backend';
import { HistoryError, type Binding, type Oid, type RepoMeta, type Signature, type VersionStore } from '../../evolution/contracts';
import { randomId } from '../../evolution/hash';
import { decideIdentity, copyIdOf, type CopyKey, type KnownHistory } from '../../evolution/identity';
import { processLocks, repoLock, type LockRunner } from '../../evolution/locks';
import { branchOf } from '../../evolution/refs';
import { IDLE_STATE, decide, isPending, step, type SchedulerConfig, type SchedulerEvent, type SchedulerState } from '../../evolution/scheduler';
import { formatMessage, type Initiator } from '../../evolution/trailers';
import type { ComputeApi } from './client';
import { INITIAL_EVOLUTION, useEvolutionStore, type CaptureState } from './evolutionStore';

export interface EditorPort {
  /** The whole file as it is now (`fileOf`), never with a live, unsaved camera folded in. */
  file(): DraftDocument;
  /** Increases with every edit and every load: a capture's snapshot is named by it. */
  generation(): number;
  /** No gesture is held: the document is in a consistent state. */
  atBoundary(): boolean;
  /**
   * The open diagram is this device's own to record: not a share link's read-only copy, not a guest's
   * copy in someone else's live session. Absent means always.
   */
  recordable?(): boolean;
}

export interface Clock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface OperationContext {
  token: number;
  copyId: string;
  readOnly: boolean;
  store: VersionStore | null;
  binding: Binding | null;
  meta: RepoMeta | null;
  tip: Oid | null;
  tipBlob: string | null;
  tipDocument: DraftDocument | null;
}

export interface Attribution {
  contributors: string[];
  agents: string[];
  collabSeq?: number;
}

export interface ServiceDeps {
  backend: () => HistoryBackend;
  compute: ComputeApi;
  editor: EditorPort;
  clock: Clock;
  schedule: () => SchedulerConfig;
  /** Whether history is on for this device. */
  enabled: () => boolean;
  /** Who records: the person's configured Git identity, or this device's. Never a fabricated person. */
  signature: (at: number) => Signature;
  /** Holds the copy's editing lock for history; `null` when another tab already records it. */
  holdCopy: (copyId: string) => Promise<(() => void) | null>;
  /**
   * Who contributed to what is being captured: given the elements this revision changes, the people
   * whose changes to them the snapshot actually contains (never everyone who was connected).
   */
  attribution?: (changedKeys: string[]) => Attribution;
  /** Whether this device has shown the first-use note. */
  firstUseSeen: () => boolean;
  /**
   * Whether a working copy is still on this device: a library diagram deleted since is not, though its
   * binding is kept. Absent, or unsure, it is, so no history a diagram still uses is taken for unused.
   */
  copyExists?: (copyId: string) => Promise<boolean>;
  /**
   * Serialises changes to a history's `repo.json` across tabs and windows, under the repository's
   * lock (Web Locks). Absent: within this page only.
   */
  lock?: LockRunner;
}

interface Session {
  readonly token: number;
  readonly copyId: string;
  readonly documentId: string;
  binding: Binding | null;
  store: VersionStore | null;
  meta: RepoMeta | null;
  tip: Oid | null;
  tipBlob: string | null;
  /** The history content of the tip, for describing the next revision. */
  tipDocument: DraftDocument | null;
  schedule: SchedulerState;
  timer: unknown;
  release: (() => void) | null;
  /** The identity question, while one is open. */
  question: { candidate: KnownHistory; relation: 'moved' | 'copy' } | null;
  readOnly: boolean;
  /** Recording is paused for this diagram; kept on the session so removing its history keeps it paused. */
  paused: boolean;
  /** An interrupted switch waits for the person: until they answer, nothing is recorded on either alternative. */
  held: boolean;
  initiator: Initiator;
  agents: Set<string>;
}

let tokens = 0;

/** Revisions between background maintenance runs (packing, pruning what nothing reaches). */
const MAINTAIN_EVERY = 40;

export class HistoryService {
  private session: Session | null = null;
  private recorded = 0;
  /** The last binding write this service sent: the next one waits for it (`afterBindingWrites`). */
  private bindingWrites: Promise<void> = Promise.resolve();

  private readonly deps: ServiceDeps;
  private readonly lock: LockRunner;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.lock = deps.lock ?? processLocks();
  }

  /** The current session's token: async work compares it to know it still belongs to the editor. */
  get current(): number | null {
    return this.session?.token ?? null;
  }

  private setCapture(session: Session, capture: CaptureState): void {
    if (this.session !== session) return;
    useEvolutionStore.setState({ capture });
  }

  private publishTip(session: Session, revisionsDelta = 0): void {
    if (this.session !== session) return;
    useEvolutionStore.setState((state) => ({
      repoId: session.store?.repoId ?? null,
      altId: session.binding?.altId ?? null,
      altName: session.binding?.altId ? (session.meta?.alternatives.find((alt) => alt.altId === session.binding!.altId)?.name ?? null) : null,
      tip: session.tip,
      revisions: state.revisions + revisionsDelta,
      changes: state.changes + (revisionsDelta > 0 ? 1 : 0),
    }));
  }

  /**
   * Starts recording history for a working copy. Reads its binding (or decides how to bind it),
   * loads the tip it is on, and compares the working copy with it. Never writes anything.
   */
  async attach(key: CopyKey, options: { readOnly?: boolean } = {}): Promise<void> {
    await this.detach({ capture: false });
    const copyId = copyIdOf(key);
    const file = this.deps.editor.file();
    const session: Session = {
      token: ++tokens,
      copyId,
      documentId: file.metadata.id,
      binding: null,
      store: null,
      meta: null,
      tip: null,
      tipBlob: null,
      tipDocument: null,
      schedule: IDLE_STATE,
      timer: null,
      release: null,
      question: null,
      readOnly: options.readOnly === true,
      paused: false,
      held: false,
      initiator: 'auto',
      agents: new Set(),
    };
    this.session = session;
    useEvolutionStore.setState({ ...INITIAL_EVOLUTION, copyId, firstUse: !this.deps.firstUseSeen(), changes: useEvolutionStore.getState().changes + 1 });
    if (!this.deps.enabled()) {
      this.setCapture(session, { kind: 'off', reason: 'device' });
      return;
    }
    if (session.readOnly) {
      this.setCapture(session, { kind: 'off', reason: 'shared' });
      return;
    }
    try {
      const release = await this.deps.holdCopy(copyId);
      if (this.session !== session) {
        release?.();
        return;
      }
      if (!release) {
        session.readOnly = true;
        this.setCapture(session, { kind: 'elsewhere' });
        return;
      }
      session.release = release;
      const backend = this.deps.backend();
      const working = await this.deps.compute.prepare(file);
      // After this service's own writes: a pause still on its way when the diagram was reopened.
      await this.bindingWrites;
      const binding = await backend.binding(copyId);
      if (this.session !== session) return;
      if (binding) {
        await this.bind(session, binding);
      } else {
        const histories = await this.knownHistories(backend);
        const decision = decideIdentity({ copyId, documentId: file.metadata.id, working: working.blobId, binding: undefined, histories });
        if (decision.kind === 'ask') {
          session.question = { candidate: decision.candidate, relation: decision.relation };
          this.setCapture(session, { kind: 'identity', title: decision.candidate.title, relation: decision.relation });
          return;
        }
      }
      if (this.session !== session) return;
      this.restart(session, session.tipBlob !== working.blobId);
    } catch (error) {
      this.setCapture(session, { kind: 'unavailable', message: messageOf(error) });
    }
  }

  /**
   * The scheduler starts again from whether the working copy differs from the tip, and the status
   * says where that leaves it. This once overwrote the pause `bind` had just shown, so a paused
   * diagram reopened saying its changes would be added in a moment, and "Add to history now" did nothing.
   */
  private restart(session: Session, dirty: boolean): void {
    const now = this.deps.clock.now();
    this.dispatch(session, { kind: 'reset', at: now, generation: this.deps.editor.generation(), dirty });
    this.setCapture(session, this.idle(session, dirty, now));
  }

  /** What the status says while no capture runs: paused wins, since nothing is recorded then. */
  private idle(session: Session, pending: boolean, since: number): CaptureState {
    if (session.paused) return { kind: 'off', reason: 'diagram' };
    return pending ? { kind: 'pending', since } : { kind: 'up-to-date' };
  }

  private async knownHistories(backend: HistoryBackend): Promise<KnownHistory[]> {
    const [metas, bindings] = await Promise.all([backend.list(), backend.bindings()]);
    return metas.map((meta) => ({
      repoId: meta.repoId,
      documentId: meta.documentId,
      title: meta.title,
      copies: bindings.filter((binding) => binding.repoId === meta.repoId).map((binding) => ({ copyId: binding.copyId, lastWorking: binding.lastSeen, stillExists: true })),
      recentContent: [],
    }));
  }

  /** Opens the bound history and reads the tip of the copy's alternative. */
  private async bind(session: Session, binding: Binding): Promise<void> {
    const backend = this.deps.backend();
    const store = await backend.open(binding.repoId);
    if (!store) {
      // The history was removed: the copy simply starts afresh at its next capture.
      await this.writeBinding(binding.copyId, null);
      return;
    }
    const meta = await store.meta();
    const tip = await store.readRef(branchOf(binding.altId));
    session.binding = binding;
    session.store = store;
    session.meta = meta;
    session.tip = tip;
    session.paused = binding.paused === true || meta.paused === true;
    if (session.paused) this.setCapture(session, { kind: 'off', reason: 'diagram' });
    if (tip) {
      const parsed = await this.deps.compute.parse(await store.readSnapshot(tip));
      session.tipBlob = parsed.blobId;
      session.tipDocument = parsed.document;
      const commit = await store.readCommit(tip);
      if (this.session === session) useEvolutionStore.setState({ tipAt: commit.committer.timestamp * 1000 });
    }
    this.publishTip(session);
  }

  /** The person answered "Continue its history" (`true`) or "Start new history" (`false`). */
  async answerIdentity(continueHistory: boolean): Promise<void> {
    const session = this.session;
    if (!session?.question) return;
    const { candidate, relation } = session.question;
    session.question = null;
    try {
      if (continueHistory) {
        let altId: string | null = null;
        if (session.question === null && relation === 'copy') {
          // A copy carries the past on but goes its own way: an alternative of its own, started where
          // the original's history is, so the two never record onto one branch.
          const store = await this.deps.backend().open(candidate.repoId);
          const tip = store ? await store.readRef(branchOf(null)) : null;
          if (store && tip) {
            altId = randomId('a');
            const made = await store.updateRef({ ref: branchOf(altId), expected: null, next: tip });
            if (made.ok) {
              const alternative = { altId, name: `Copy: ${this.deps.editor.file().metadata.title}`.slice(0, 80), createdAt: this.deps.clock.now(), from: tip };
              await this.changeMeta(store, (meta) => ({ ...meta, alternatives: [...meta.alternatives, alternative] }));
            } else {
              altId = null;
            }
          }
        }
        const binding: Binding = { copyId: session.copyId, repoId: candidate.repoId, altId, documentId: session.documentId, lastSeen: null, at: this.deps.clock.now() };
        await this.writeBinding(binding.copyId, binding);
        await this.bind(session, binding);
      }
      const working = await this.deps.compute.prepare(this.deps.editor.file());
      this.restart(session, session.tipBlob !== working.blobId);
    } catch (error) {
      this.setCapture(session, { kind: 'unavailable', message: messageOf(error) });
    }
  }

  /** Stops recording for the current copy, first recording what is pending when it can. */
  async detach(options: { capture: boolean } = { capture: true }): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (options.capture && isPending(session.schedule) && session.schedule.inFlight === null && this.deps.editor.atBoundary()) {
      await this.capture(session, 'auto').catch(() => undefined);
    }
    this.deps.clock.clearTimeout(session.timer);
    session.release?.();
    if (this.session === session) {
      this.session = null;
      useEvolutionStore.setState({ ...INITIAL_EVOLUTION, changes: useEvolutionStore.getState().changes + 1 });
    }
  }

  /** An edit happened. `agent` names the agent whose reviewed change it was. */
  noteEdit(agent?: string): void {
    const session = this.session;
    if (!session || session.readOnly || session.question) return;
    if (this.deps.editor.recordable && !this.deps.editor.recordable()) return;
    if (agent) session.agents.add(agent);
    const now = this.deps.clock.now();
    const wasClean = session.schedule.dirtySince === null;
    this.dispatch(session, { kind: 'edit', at: now, generation: this.deps.editor.generation(), agent: agent !== undefined });
    if (wasClean && useEvolutionStore.getState().capture.kind === 'up-to-date') this.setCapture(session, { kind: 'pending', since: now });
  }

  /** An agent's reviewed batch finished: what it changed is due as one revision. */
  agentSettled(): void {
    const session = this.session;
    if (!session) return;
    session.initiator = session.agents.size > 0 ? 'agent' : session.initiator;
    this.dispatch(session, { kind: 'agent-settled', at: this.deps.clock.now() });
  }

  /** Record now (at the next consistent boundary): "Capture now", a lifecycle edge, an explicit step. */
  requestCapture(initiator: Initiator = 'manual'): void {
    const session = this.session;
    if (!session || session.readOnly) return;
    session.initiator = initiator;
    this.dispatch(session, { kind: 'request', at: this.deps.clock.now() });
  }

  private dispatch(session: Session, event: SchedulerEvent): void {
    session.schedule = step(session.schedule, event);
    this.arm(session);
  }

  private arm(session: Session): void {
    if (this.session !== session) return;
    this.deps.clock.clearTimeout(session.timer);
    session.timer = null;
    const now = this.deps.clock.now();
    const decision = decide(session.schedule, now, this.deps.editor.atBoundary(), this.deps.schedule());
    if (decision.kind === 'idle') return;
    if (decision.kind === 'wait') {
      session.timer = this.deps.clock.setTimeout(() => this.arm(session), Math.max(0, decision.until - now));
      return;
    }
    void this.capture(session, session.initiator).catch(() => undefined);
  }

  /**
   * Records the working copy as a revision on the session's branch. Bound to `session` throughout:
   * if the editor moves on to another copy meanwhile, this still finishes into the history and
   * branch it began with, and touches no editor state.
   */
  private async capture(session: Session, initiator: Initiator): Promise<void> {
    if (session.readOnly || session.question || session.held || session.meta?.paused || session.paused) return;
    if (!this.deps.enabled()) return;
    const generation = this.deps.editor.generation();
    const snapshot = this.deps.editor.file();
    // The editor may already hold another diagram (one opened as this one closed), or a copy that is
    // not this device's to record. Never record either into this copy's history: what this copy had
    // pending is safe in autosave and is recorded the next time it opens.
    if (snapshot.metadata.id !== session.documentId) return;
    if (this.deps.editor.recordable && !this.deps.editor.recordable()) return;
    session.schedule = step(session.schedule, { kind: 'started', at: this.deps.clock.now(), generation });
    // The label the next capture was asked for when this one began: one asked for while this one
    // runs (an outside change arriving mid-capture) is that next capture's, and survives this one.
    const asked = session.initiator;
    this.setCapture(session, { kind: 'capturing' });
    try {
      const prepared = await this.deps.compute.prepare(snapshot);
      if (prepared.blobId === session.tipBlob) {
        // Undone back to what is recorded, or nothing durable changed: no revision.
        this.finish(session, false);
        return;
      }
      const backend = this.deps.backend();
      if (!session.store) await this.startHistory(session, backend, snapshot);
      const store = session.store!;
      const ref = branchOf(session.binding?.altId ?? null);
      const content = historyContent(snapshot);
      const description = await this.deps.compute.describe(session.tipDocument, content);
      const attribution = this.deps.attribution?.(description.keys) ?? { contributors: [], agents: [] };
      const agents = [...new Set([...attribution.agents, ...session.agents])];
      const at = this.deps.clock.now();
      const signature = this.deps.signature(at);
      const message = formatMessage({
        summary: description.summary,
        body: description.body,
        trailers: {
          initiator: agents.length > 0 && initiator === 'auto' ? 'agent' : initiator,
          documentId: snapshot.metadata.id,
          ...(session.binding?.altId ? { alternative: session.binding.altId } : {}),
          categories: description.categories,
          contributors: attribution.contributors,
          agents,
          ...(attribution.collabSeq !== undefined ? { collabSeq: attribution.collabSeq } : {}),
        },
      });
      let parent = session.tip;
      let oid = await store.writeSnapshot({ text: prepared.text, parents: parent ? [parent] : [], author: signature, committer: signature, message });
      let result = await store.updateRef({ ref, expected: parent, next: oid });
      if (!result.ok) {
        // Another writer moved this branch (another window on the same history). Nothing is
        // lost either way: their revision stays, and ours is recorded on top of it.
        const actual = result.actual;
        if (actual) {
          const theirs = await this.deps.compute.parse(await store.readSnapshot(actual));
          if (theirs.blobId === prepared.blobId) {
            oid = actual;
            result = { ok: true };
          } else {
            parent = actual;
            oid = await store.writeSnapshot({ text: prepared.text, parents: [actual], author: signature, committer: signature, message });
            result = await store.updateRef({ ref, expected: actual, next: oid });
          }
        }
        if (!result.ok && result.actual === null && parent !== null) {
          throw new HistoryError('not-found', 'This alternative was archived or removed elsewhere. Switch to another one to keep recording; the diagram itself is safe.');
        }
        if (!result.ok) throw new HistoryError('conflict', 'History changed elsewhere while recording; it will try again.');
      }
      session.tip = oid;
      session.tipBlob = prepared.blobId;
      session.tipDocument = content;
      // Reset unconditionally, this once relabelled the reloaded outside change as `auto` whenever it
      // landed while the capture of the person's own edits was still being written.
      if (session.initiator === asked) session.initiator = 'auto';
      session.agents.clear();
      if (session.binding) {
        session.binding = { ...session.binding, lastSeen: oid, at };
        await this.writeBinding(session.copyId, session.binding).catch(() => undefined);
      }
      if (this.session === session) useEvolutionStore.setState({ tipAt: at });
      this.publishTip(session, 1);
      this.recorded += 1;
      if (this.recorded % MAINTAIN_EVERY === 0) void store.maintain().catch(() => undefined);
      this.finish(session, true);
    } catch (error) {
      session.schedule = step(session.schedule, { kind: 'failed', at: this.deps.clock.now() });
      const quota = error instanceof HistoryError && error.code === 'quota';
      const gone = error instanceof HistoryError && error.code === 'not-found';
      this.setCapture(session, { kind: 'failed', message: messageOf(error), quota, retryAt: gone ? null : session.schedule.retryAt });
      // A branch that is gone does not come back by retrying: wait for the person instead.
      if (!gone) this.arm(session);
      throw error;
    }
  }

  private finish(session: Session, _recorded: boolean): void {
    session.schedule = step(session.schedule, { kind: 'succeeded', at: this.deps.clock.now() });
    this.setCapture(session, this.idle(session, isPending(session.schedule), session.schedule.dirtySince ?? this.deps.clock.now()));
    this.arm(session);
  }

  /** The first capture of a copy with no history: a new repository, and the copy bound to it. */
  private async startHistory(session: Session, backend: HistoryBackend, snapshot: DraftDocument): Promise<void> {
    const at = this.deps.clock.now();
    const meta: RepoMeta = { repoId: randomId('r'), documentId: snapshot.metadata.id, title: snapshot.metadata.title, createdAt: at, alternatives: [] };
    const store = await backend.create(meta);
    const binding: Binding = { copyId: session.copyId, repoId: meta.repoId, altId: null, documentId: snapshot.metadata.id, lastSeen: null, at };
    await this.writeBinding(binding.copyId, binding);
    session.store = store;
    session.meta = meta;
    session.binding = binding;
    session.tip = null;
  }

  /**
   * Stops (or resumes) recording this diagram's history. What is already recorded stays. Kept on
   * this copy's binding: a copy that continued another diagram's history shares its `repo.json`, and
   * a pause kept there paused the other diagram too.
   *
   * The session takes the pause before its write is sent, never once it is answered: a capture
   * finishing in between wrote the binding it had read, without the pause, after it. The diagram
   * said paused, and recorded again the next time it was opened.
   */
  async setPaused(paused: boolean): Promise<void> {
    const session = this.session;
    if (!session?.store || !session.binding) return;
    session.paused = paused;
    session.binding = withPause(session.binding, paused);
    if (paused) this.setCapture(session, { kind: 'off', reason: 'diagram' });
    const backend = this.deps.backend();
    const { copyId } = session;
    await this.afterBindingWrites(async () => {
      // The binding as stored when this write's turn comes, not as the session read it: a switch
      // between alternatives may have moved the copy since, and adopts it only once it is done.
      // Nothing stored is a history removed meanwhile, which a pause must not bring back.
      const stored = await backend.binding(copyId);
      if (stored) await backend.putBinding(withPause(stored, paused));
    });
    if (paused) return;
    if (session.meta?.paused) {
      // A pause an earlier version kept for the whole history: resuming this copy lifts it.
      await this.changeMeta(session.store, (meta) => {
        const next = { ...meta };
        delete next.paused;
        return next;
      });
    }
    const working = await this.deps.compute.prepare(this.deps.editor.file());
    this.restart(session, working.blobId !== session.tipBlob);
  }

  /**
   * Stores `binding` (or, given `null`, removes the copy's) after every binding write this service
   * sent before it.
   */
  private writeBinding(copyId: string, binding: Binding | null): Promise<void> {
    const backend = this.deps.backend();
    return this.afterBindingWrites(() => (binding ? backend.putBinding(binding) : backend.deleteBinding(copyId)));
  }

  /**
   * Runs `write` once every binding write before it is answered, so bindings are stored in the order
   * this service changed them, whatever a backend does with requests in flight together (the history
   * worker answers each as it finishes; the desktop shell runs them on threads of its own). Each
   * change is made to the session's `binding` before its write is sent, so the last one to land holds
   * them all.
   */
  private afterBindingWrites(write: () => Promise<void>): Promise<void> {
    const done = this.bindingWrites.then(write);
    this.bindingWrites = done.catch(() => undefined);
    return done;
  }

  /** Replaces part of this history's `repo.json` (its remote settings, say). `null` when there is none to change. */
  async updateMeta(change: (meta: RepoMeta) => RepoMeta): Promise<RepoMeta | null> {
    const session = this.session;
    if (!session?.store || !session.meta || session.readOnly) return null;
    return this.changeMeta(session.store, change);
  }

  /**
   * Changes `store`'s `repo.json` from what it holds now, under the repository's lock. Another window
   * recording a copy of the same history may have changed it since this session read it (its own
   * "Copy: …" alternative, a publishing setting): writing the session's copy back once dropped that.
   */
  async changeMeta(store: VersionStore, change: (meta: RepoMeta) => RepoMeta): Promise<RepoMeta> {
    const meta = await this.lock(repoLock(store.repoId), async () => {
      const next = change(await store.meta());
      await store.writeMeta(next);
      return next;
    });
    if (this.session?.store?.repoId === store.repoId) this.session.meta = meta;
    return meta;
  }

  get paused(): boolean {
    return this.session?.paused === true;
  }

  /** The document id of the copy history is attached to. */
  get documentId(): string | null {
    return this.session?.documentId ?? null;
  }

  /**
   * The whole history of this diagram — every alternative and milestone — as a standard Git bundle
   * (`git clone history.bundle` opens it). Archived alternatives come too when asked for.
   */
  async exportHistory(options: { archived?: boolean } = {}): Promise<{ bytes: Uint8Array; title: string } | null> {
    const session = this.session;
    if (!session?.store || !session.meta) return null;
    const refs = [
      ...(await session.store.listRefs('refs/heads')).filter((entry) => options.archived || !entry.ref.startsWith('refs/heads/archive/')),
      ...(await session.store.listRefs('refs/tags/milestone')),
    ];
    if (refs.length === 0) return null;
    const bytes = await this.deps.backend().exportBundle(session.store.repoId, refs);
    return { bytes, title: session.meta.title };
  }

  /** How many other working copies on this device record into this diagram's history (copies that continued it). */
  async sharedWith(): Promise<number> {
    const session = this.session;
    if (!session?.store) return 0;
    return this.othersOn(session, session.store.repoId);
  }

  /**
   * The other working copies on this device that record into `repoId`, leaving out any deleted since.
   * A deleted diagram's binding is kept, and counted here it once kept the history from being removed
   * for nobody, while Settings spoke of "the other diagram", which was gone.
   */
  private async othersOn(session: Session, repoId: string): Promise<number> {
    const others = (await this.deps.backend().bindings()).filter((binding) => binding.repoId === repoId && binding.copyId !== session.copyId);
    const exists = this.deps.copyExists;
    if (!exists) return others.length;
    const live = await Promise.all(others.map((binding) => exists(binding.copyId).catch(() => true)));
    return live.filter(Boolean).length;
  }

  /**
   * Removes this diagram's history from this device, after the person confirmed. The diagram itself
   * is untouched, and copies already published or exported are not affected — the person is told so
   * before they confirm. Recording starts afresh with the next change unless history is paused.
   *
   * A history another copy continues is theirs too: removing it here once deleted the other
   * diagram's revisions, alternatives and milestones, behind a warning about this diagram alone.
   * Then this diagram only lets go of it, unless the person chose to remove it for `everywhere`.
   */
  async removeHistory(options: { everywhere?: boolean } = {}): Promise<void> {
    const session = this.session;
    if (!session?.store) return;
    const repoId = session.store.repoId;
    const backend = this.deps.backend();
    // After the binding writes already sent: one still on its way (a capture's) would put back the
    // binding removed here.
    if (!options.everywhere && (await this.othersOn(session, repoId)) > 0) await this.writeBinding(session.copyId, null);
    else await this.afterBindingWrites(() => backend.remove(repoId));
    session.store = null;
    session.meta = null;
    session.binding = null;
    session.tip = null;
    session.tipBlob = null;
    session.tipDocument = null;
    useEvolutionStore.setState({ repoId: null, tip: null, tipAt: null, revisions: 0, changes: useEvolutionStore.getState().changes + 1 });
    // Nothing is recorded again until something changes — or ever, while recording is paused.
    this.dispatch(session, { kind: 'reset', at: this.deps.clock.now(), generation: this.deps.editor.generation(), dirty: false });
    this.setCapture(session, session.paused ? { kind: 'off', reason: 'diagram' } : { kind: 'empty' });
  }

  /**
   * Imports a bundle as a separate history on this device. Nothing existing is replaced: the result
   * is bound to nothing until `adoptHistory` (the person chose "Use it for this diagram").
   */
  async importHistory(bytes: Uint8Array): Promise<ImportedHistory> {
    const at = this.deps.clock.now();
    const meta: RepoMeta = { repoId: randomId('r'), documentId: '', title: 'Imported history', createdAt: at, alternatives: [] };
    const imported = await this.deps.backend().importBundle(bytes, meta);
    const store = await this.deps.backend().open(imported.repoId);
    if (store) await store.writeMeta({ ...(await store.meta()), title: this.deps.editor.file().metadata.title });
    return imported;
  }

  /**
   * Binds the open copy to an imported history. Its previous history stays on this device (listed
   * in Settings → History). The working copy is compared with the imported tip; any difference is
   * recorded as the next revision, so nothing on the canvas is lost or silently replaced.
   */
  async adoptHistory(repoId: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    // A pause is this diagram's, and stays with it into the history it now continues.
    const binding: Binding = { copyId: session.copyId, repoId, altId: null, documentId: session.documentId, lastSeen: null, at: this.deps.clock.now(), ...(session.paused ? { paused: true } : {}) };
    await this.writeBinding(binding.copyId, binding);
    session.store = null;
    session.tip = null;
    session.tipBlob = null;
    session.tipDocument = null;
    await this.bind(session, binding);
    const working = await this.deps.compute.prepare(this.deps.editor.file());
    this.restart(session, working.blobId !== session.tipBlob);
  }

  /** Bytes all histories take on this device. */
  usage(): Promise<number> {
    return this.deps.backend().usage();
  }

  /**
   * What an operation (`operations.ts`) needs to know about the open session, as a snapshot it
   * carries through its steps (ADR-3): the result is applied only if `token` is still current.
   */
  context(): OperationContext | null {
    const session = this.session;
    if (!session) return null;
    return {
      token: session.token,
      copyId: session.copyId,
      readOnly: session.readOnly || session.question !== null,
      store: session.store,
      binding: session.binding,
      meta: session.meta,
      tip: session.tip,
      tipBlob: session.tipBlob,
      tipDocument: session.tipDocument,
    };
  }

  /**
   * Writes a working copy's binding (an operation moved it to another alternative). The operation
   * built it from the binding it read as it began, so the open copy's pause is the session's now.
   */
  putBindingFor(binding: Binding): Promise<void> {
    const session = this.session;
    return this.writeBinding(binding.copyId, session?.copyId === binding.copyId ? withPause(binding, session.paused) : binding);
  }

  /**
   * Holds recording while a switch a crash interrupted waits for the person (Resume or Keep
   * current): the copy's binding may already name the alternative it was going to, while what is
   * on screen is still the one it left, so a capture now would put it on the wrong one.
   */
  holdCapture(held: boolean): void {
    const session = this.session;
    if (!session) return;
    session.held = held;
    if (!held) this.arm(session);
  }

  /** Records what is pending now and waits for it, so an operation starts from a recorded state. */
  async flush(): Promise<void> {
    const session = this.session;
    if (!session || session.readOnly || session.question) return;
    if (session.schedule.inFlight !== null) {
      // One is running: wait for it by polling its end, briefly.
      for (let i = 0; i < 200 && session.schedule.inFlight !== null; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!session.store || isPending(session.schedule)) await this.capture(session, 'auto');
    // Its binding too, for whoever reads it next from storage (a draft saved to a file moves it).
    await this.bindingWrites;
  }

  /**
   * An operation moved the session's history: adopt its new tip (and binding or metadata) if the
   * session is still the one it began in. The working copy is then compared afresh.
   */
  async adopt(token: number, next: { tip: Oid | null; binding?: Binding; meta?: RepoMeta; store?: VersionStore }): Promise<void> {
    const session = this.session;
    if (!session || session.token !== token) return;
    if (next.store) session.store = next.store;
    if (next.binding) session.binding = withPause(next.binding, session.paused);
    if (next.meta) session.meta = next.meta;
    session.tip = next.tip;
    if (next.tip && session.store) {
      const parsed = await this.deps.compute.parse(await session.store.readSnapshot(next.tip));
      session.tipBlob = parsed.blobId;
      session.tipDocument = parsed.document;
    } else {
      session.tipBlob = null;
      session.tipDocument = null;
    }
    if (this.session !== session) return;
    const working = await this.deps.compute.prepare(this.deps.editor.file());
    this.restart(session, working.blobId !== session.tipBlob);
    useEvolutionStore.setState({ tipAt: this.deps.clock.now() });
    this.publishTip(session, 1);
  }

  /** The open session's history, for views (timeline, compare) to read. */
  get store(): VersionStore | null {
    return this.session?.store ?? null;
  }

  get binding(): Binding | null {
    return this.session?.binding ?? null;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof HistoryError) return error.message;
  return 'History could not be recorded.';
}

/** `binding` with the copy's pause as given: `paused: true`, or no `paused` at all. */
function withPause(binding: Binding, paused: boolean): Binding {
  const next: Binding = { ...binding, paused };
  if (!paused) delete next.paused;
  return next;
}
