/**
 * Publishing a diagram's history, and committing a diagram into its project's repository — the
 * desktop's two optional Git features (ADR-4), as the page drives them. Every check that matters
 * runs in Rust (`historyRemote.ts` says which); this module keeps the person's choices in the
 * history's own `repo.json`, shows where a remote stands, and never reaches the network unless the
 * person asked or chose a policy that does.
 *
 * - **Connect** stores a validated URL; nothing is sent.
 * - **Fetch** updates the remote-tracking branches only. Incoming revisions are brought in by the
 *   same merge as alternatives (`startMerge(..., remote)`): a fast-forward adopts the remote tip.
 * - **Publish** sends explicit refs, never forced. The first publish to a destination is previewed
 *   and confirmed; a policy that publishes by itself only ever does so to a confirmed destination.
 * - **Project** commits go to the diagram's own branch by default, leaving HEAD, the index and
 *   the work tree alone; the current branch only when the person picks it and every check passes.
 */
import type { Oid, PublishPolicy, RefName, RemoteMeta } from '../evolution/contracts';
import { branchOf, MILESTONE_PREFIX, remoteBranchOf } from '../evolution/refs';
import { historyService } from '../store/evolution/bridge';
import { useEvolutionStore, type RemoteState } from '../store/evolution/evolutionStore';
import { startMerge } from '../store/evolution/merging';
import type { Outcome } from '../store/evolution/operations';
import type { DesktopApi, Handle } from './api';
import {
  commitToCurrentBranch,
  fetchRemote,
  gitStatus,
  previewProjectPush,
  previewPush,
  projectRepo,
  publishToBranch,
  pushProjectBranch,
  pushRefs,
  removeRemote,
  RemoteHistoryError,
  setRemote,
  type GitStatus,
  type ProjectPublished,
  type ProjectPushPreview,
  type ProjectRepoInfo,
  type RemotePushPreview,
} from './historyRemote';

let api: DesktopApi | null = null;
let savedFile: () => { handle: Handle; name: string } | null = () => null;
let unsubscribe: (() => void) | null = null;
let publishTimer: ReturnType<typeof setTimeout> | null = null;

/** How long after the last new revision an automatic publish waits, so a burst of work is one push. */
const AUTO_PUBLISH_DELAY = 60_000;

export const POLICIES: { policy: PublishPolicy; label: string; description: string }[] = [
  { policy: 'manual', label: 'When I publish', description: 'Nothing leaves this device until you press Publish.' },
  { policy: 'idle', label: 'Shortly after each revision', description: 'A minute after history records something new.' },
  { policy: 'milestones', label: 'Only milestones', description: 'Named milestones and the revisions they need, as you name them.' },
];

/** Wires the module to the shell; called once at boot. */
export function installRemoteHistory(desktop: DesktopApi, file: () => { handle: Handle; name: string } | null): void {
  api = desktop;
  savedFile = file;
  unsubscribe?.();
  unsubscribe = useEvolutionStore.subscribe((state, previous) => {
    if (state.repoId !== previous.repoId) {
      cancelAutoPublish();
      void refreshLocalState();
    } else if (state.changes !== previous.changes) {
      scheduleAutoPublish();
    }
  });
}

function shell(): DesktopApi {
  if (!api) throw new RemoteHistoryError('unavailable', 'Publishing is only available in the desktop app.');
  return api;
}

function setRemoteState(remote: RemoteState): void {
  useEvolutionStore.setState({ remote });
}

/** The person-facing sentence for a refusal: Rust's own wording, which already says what to do. */
export function remoteMessage(error: unknown): string {
  if (error instanceof RemoteHistoryError) {
    if (error.reason === 'git-missing') return 'Git is not installed, or Draft Canvas could not find it. Install Git, then try again.';
    if (error.reason === 'auth') return 'The remote asked you to sign in. Sign in with Git on this computer (your credential manager or SSH key), then try again.';
    if (error.reason === 'rejected-non-fast-forward') return 'The remote has revisions this device does not. Fetch and bring them in first, then publish.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Git could not finish that.';
}

function failed(error: unknown): void {
  if (error instanceof RemoteHistoryError && (error.reason === 'offline' || error.reason === 'timeout')) setRemoteState({ kind: 'offline' });
  else setRemoteState({ kind: 'failed', message: remoteMessage(error) });
}

function current() {
  const context = historyService().context();
  if (!context?.store || !context.meta) return null;
  return { context, store: context.store, meta: context.meta, ref: branchOf(context.binding?.altId ?? null) };
}

export function remoteOf(): RemoteMeta | null {
  return current()?.meta.remote ?? null;
}

export function checkGit(): Promise<GitStatus> {
  return gitStatus(shell());
}

/** Where this alternative stands against what was last fetched, worked out locally: no network. */
async function refreshLocalState(): Promise<void> {
  const now = current();
  if (!now?.meta.remote) {
    setRemoteState({ kind: 'none' });
    return;
  }
  try {
    const remoteTip = await now.store.readRef(remoteBranchOf(now.ref));
    setRemoteState(await standing(now.store, now.context.tip, remoteTip));
  } catch {
    setRemoteState({ kind: 'not-published', ahead: 0 });
  }
}

async function standing(store: NonNullable<ReturnType<typeof current>>['store'], local: Oid | null, remote: Oid | null): Promise<RemoteState> {
  if (!local) return remote ? { kind: 'incoming', behind: 1 } : { kind: 'not-published', ahead: 0 };
  if (!remote) return { kind: 'not-published', ahead: (await store.log({ from: [local], limit: 500, hide: [] })).length };
  if (local === remote) return { kind: 'published' };
  const ahead = (await store.log({ from: [local], limit: 500, hide: [remote] })).length;
  const behind = (await store.log({ from: [remote], limit: 500, hide: [local] })).length;
  if (ahead > 0 && behind > 0) return { kind: 'diverged' };
  if (behind > 0) return { kind: 'incoming', behind };
  return ahead > 0 ? { kind: 'not-published', ahead } : { kind: 'published' };
}

/** Makes `url` this history's remote. Returns the address as stored. Nothing is sent. */
export async function connectRemote(url: string): Promise<string> {
  const now = current();
  if (!now) throw new RemoteHistoryError('unavailable', 'This diagram has no history yet.');
  const stored = await setRemote(shell(), now.store.repoId, url.trim());
  await historyService().updateMeta((meta) => ({ ...meta, remote: { url: stored, policy: meta.remote?.policy ?? 'manual', publishAlternatives: meta.remote?.publishAlternatives ?? [] } }));
  await refreshLocalState();
  return stored;
}

/** Forgets the remote. Whatever was published stays where it is. */
export async function disconnectRemote(): Promise<void> {
  const now = current();
  if (!now) return;
  cancelAutoPublish();
  await removeRemote(shell(), now.store.repoId);
  await historyService().updateMeta((meta) => {
    const next = { ...meta };
    delete next.remote;
    return next;
  });
  setRemoteState({ kind: 'none' });
}

export async function setPublishPolicy(policy: PublishPolicy): Promise<void> {
  await historyService().updateMeta((meta) => (meta.remote ? { ...meta, remote: { ...meta.remote, policy } } : meta));
}

export async function setPublishedAlternatives(altIds: string[]): Promise<void> {
  await historyService().updateMeta((meta) => (meta.remote ? { ...meta, remote: { ...meta.remote, publishAlternatives: altIds } } : meta));
}

/** Fetches, then says where this alternative stands. Never changes the diagram. */
export async function fetchNow(): Promise<RemoteState> {
  const now = current();
  if (!now?.meta.remote) throw new RemoteHistoryError('unavailable', 'Connect a remote first.');
  try {
    const outcome = await fetchRemote(shell(), now.store.repoId);
    const branch = outcome.branches.find((entry) => entry.branch === now.ref);
    const state = await standing(now.store, now.context.tip, branch?.remote ?? null);
    setRemoteState(state);
    return state;
  } catch (error) {
    failed(error);
    throw error;
  }
}

/** Brings in what the remote has for this alternative, as a fast-forward or a reviewed merge. */
export async function bringInRemote(): Promise<Outcome> {
  const now = current();
  if (!now) return { ok: false, message: 'This diagram has no history yet.' };
  const outcome = await startMerge(now.context.binding?.altId ?? null, undefined, true);
  void refreshLocalState();
  return outcome;
}

/** What a publish sends: this alternative, main, the ones chosen, and milestones — or milestones only. */
async function refsToPublish(): Promise<RefName[]> {
  const now = current();
  if (!now?.meta.remote) return [];
  const milestones = (await now.store.listRefs(MILESTONE_PREFIX)).map((entry) => entry.ref);
  if (now.meta.remote.policy === 'milestones') return milestones;
  const live = new Set(now.meta.alternatives.filter((alt) => !alt.archived).map((alt) => alt.altId));
  const alternatives = [now.context.binding?.altId ?? null, ...now.meta.remote.publishAlternatives].filter((altId): altId is string => altId !== null && live.has(altId));
  const branches = [branchOf(null), ...new Set(alternatives.map((altId) => branchOf(altId)))];
  const existing = await Promise.all(branches.map(async (ref) => ((await now.store.readRef(ref)) ? ref : null)));
  return [...existing.filter((ref): ref is RefName => ref !== null), ...milestones];
}

export interface PublishPlan {
  destination: string;
  /** The person has not confirmed this destination yet: publishing asks first. */
  first: boolean;
  refs: RemotePushPreview[];
}

/** What publishing would send, against what was last fetched. No network. */
export async function planPublish(): Promise<PublishPlan> {
  const now = current();
  if (!now?.meta.remote) throw new RemoteHistoryError('unavailable', 'Connect a remote first.');
  const refs = await refsToPublish();
  if (refs.length === 0) throw new RemoteHistoryError('unavailable', now.meta.remote.policy === 'milestones' ? 'There are no milestones to publish yet.' : 'There is nothing to publish yet.');
  return { destination: now.meta.remote.url, first: now.meta.remote.confirmedDestination !== now.meta.remote.url, refs: await previewPush(shell(), now.store.repoId, refs) };
}

/** Publishes what `planPublish` showed. The first publish to a destination records the confirmation. */
export async function publishNow(confirmed = false): Promise<void> {
  const now = current();
  if (!now?.meta.remote) throw new RemoteHistoryError('unavailable', 'Connect a remote first.');
  const remote = now.meta.remote;
  if (remote.confirmedDestination !== remote.url && !confirmed) throw new RemoteHistoryError('locked', 'Review the first publish to this remote before it is sent.');
  const refs = await refsToPublish();
  if (refs.length === 0) return;
  setRemoteState({ kind: 'publishing' });
  try {
    await pushRefs(shell(), now.store.repoId, refs);
    if (remote.confirmedDestination !== remote.url) {
      await historyService().updateMeta((meta) => (meta.remote ? { ...meta, remote: { ...meta.remote, confirmedDestination: meta.remote.url } } : meta));
    }
    await refreshLocalState();
  } catch (error) {
    failed(error);
    throw error;
  }
}

function cancelAutoPublish(): void {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = null;
}

/** A policy that publishes by itself does so quietly, and only to a destination the person confirmed. */
function scheduleAutoPublish(): void {
  const remote = remoteOf();
  if (!remote || remote.policy === 'manual' || remote.confirmedDestination !== remote.url) {
    void refreshLocalState();
    return;
  }
  cancelAutoPublish();
  publishTimer = setTimeout(() => {
    publishTimer = null;
    void publishNow().catch(() => undefined);
  }, remote.policy === 'milestones' ? 2_000 : AUTO_PUBLISH_DELAY);
}

// Project repositories --------------------------------------------------------------------------

export function projectFile(): { handle: Handle; name: string } | null {
  return savedFile();
}

/** The repository the saved diagram lives in, or `null` (a Quick Draft, or a file outside any). */
export async function projectInfo(): Promise<ProjectRepoInfo | null> {
  const file = savedFile();
  if (!file) return null;
  return projectRepo(shell(), file.handle);
}

function commitMessage(name: string): string {
  return `Update ${name} diagram`;
}

/** The saved file onto the diagram's own branch. HEAD, the index and the work tree are left alone. */
export async function publishProjectBranch(): Promise<ProjectPublished> {
  const file = savedFile();
  if (!file) throw new RemoteHistoryError('unavailable', 'Save the diagram to a file first.');
  return publishToBranch(shell(), file.handle, commitMessage(file.name));
}

/** The saved file onto the current branch, only if HEAD is still where the person saw it. */
export async function commitProjectCurrent(expectedHead: Oid): Promise<ProjectPublished> {
  const file = savedFile();
  if (!file) throw new RemoteHistoryError('unavailable', 'Save the diagram to a file first.');
  return commitToCurrentBranch(shell(), file.handle, commitMessage(file.name), expectedHead);
}

export async function planProjectPush(branch: string): Promise<ProjectPushPreview> {
  const file = savedFile();
  if (!file) throw new RemoteHistoryError('unavailable', 'Save the diagram to a file first.');
  return previewProjectPush(shell(), file.handle, branch);
}

export async function pushProject(branch: string): Promise<void> {
  const file = savedFile();
  if (!file) throw new RemoteHistoryError('unavailable', 'Save the diagram to a file first.');
  await pushProjectBranch(shell(), file.handle, branch);
}
