/**
 * Canvas Evolution's desktop remotes and project publishing, as thin typed calls over the shell
 * (`src-tauri/src/history/remote.rs`, `project.rs`), which run the person's own `git` hardened
 * (`gitcli.rs`). Nothing is decided here: every URL, ref, path and precondition is checked in Rust.
 *
 * The shell's refusals leave as `RemoteHistoryError`s: a `HistoryError` whose `reason` says which
 * Git failure or which publishing precondition it was, so the page can say what to do next (sign
 * in, fetch first, publish to the diagram's own branch instead).
 */
import { HistoryError, type Oid, type RefName } from '../evolution/contracts';
import {
  DesktopError,
  type DesktopApi,
  type GitStatus,
  type Handle,
  type ProjectPublished,
  type ProjectPushPreview,
  type ProjectRepoInfo,
  type RemoteFetchOutcome,
  type RemotePushedRef,
  type RemotePushPreview,
} from './api';
import { historyCodeOf } from './historyStore';

export type {
  GitStatus,
  ProjectPublished,
  ProjectPushPreview,
  ProjectRepoInfo,
  RemoteBranchState,
  RemoteFetchOutcome,
  RemotePushedRef,
  RemotePushPreview,
} from './api';

/** How running Git failed (`gitcli::Failure`). */
export type GitFailureReason =
  | 'auth'
  | 'host-key'
  | 'offline'
  | 'rejected-non-fast-forward'
  | 'protected-branch'
  | 'missing-remote-branch'
  | 'shallow'
  | 'rate-limited'
  | 'timeout'
  | 'interrupted'
  | 'git-missing'
  | 'identity'
  | 'locked'
  | 'other';

/** Why a history remote action was refused before or after Git ran (`remote.rs`). */
export type RemoteRefusalReason =
  | 'invalid-url'
  | 'url-rewritten'
  | 'no-remote'
  | 'not-publishable'
  | 'config-refused'
  | 'invalid-remote-history';

/** Why publishing into a project repository was refused (`project.rs`). */
export type ProjectRefusalReason =
  | 'not-in-repo'
  | 'submodule'
  | 'redirected-git-dir'
  | 'outside'
  | 'path'
  | 'sha256'
  | 'not-a-file'
  | 'config-refused'
  | 'filtered'
  | 'detached'
  | 'no-commits'
  | 'head-moved'
  | 'operation-in-progress'
  | 'partially-staged'
  | 'sparse'
  | 'signing-required'
  | 'index-not-updated'
  | 'missing-branch';

export type RemoteReason = GitFailureReason | RemoteRefusalReason | ProjectRefusalReason;

export class RemoteHistoryError extends HistoryError {
  /** `undefined` for a refusal with no finer reason (a bad repository id, a missing history). */
  readonly reason: RemoteReason | undefined;

  constructor(code: HistoryError['code'], message: string, reason?: string) {
    super(code, message);
    this.name = 'RemoteHistoryError';
    this.reason = reason as RemoteReason | undefined;
  }
}

async function translated<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof DesktopError) throw new RemoteHistoryError(historyCodeOf(error.kind), error.message, error.reason);
    throw error;
  }
}

export function gitStatus(api: DesktopApi): Promise<GitStatus> {
  return translated(api.historyGitStatus());
}

/** Makes `url` the history's `origin` and returns it as stored (normalised). */
export function setRemote(api: DesktopApi, repoId: string, url: string): Promise<string> {
  return translated(api.historyRemoteSet(repoId, url));
}

export function removeRemote(api: DesktopApi, repoId: string): Promise<void> {
  return translated(api.historyRemoteRemove(repoId));
}

/** Fetches `main` and alternatives; only diagram histories become remote-tracking branches. */
export function fetchRemote(api: DesktopApi, repoId: string): Promise<RemoteFetchOutcome> {
  return translated(api.historyFetch(repoId));
}

/** What publishing `refs` would send, against what was last fetched. No network. */
export function previewPush(api: DesktopApi, repoId: string, refs: RefName[]): Promise<RemotePushPreview[]> {
  return translated(api.historyPushPreview(repoId, refs));
}

/** Publishes each ref to the same name on `origin`. Never forced: a remote that moved on refuses. */
export function pushRefs(api: DesktopApi, repoId: string, refs: RefName[]): Promise<RemotePushedRef[]> {
  return translated(api.historyPush(repoId, refs));
}

/** The repository the saved file `handle` names lives in, or `null`. */
export function projectRepo(api: DesktopApi, handle: Handle): Promise<ProjectRepoInfo | null> {
  return translated(api.historyProjectRepo(handle));
}

/** Publishes the saved diagram to its own branch; HEAD, index and working tree are left alone. */
export function publishToBranch(api: DesktopApi, handle: Handle, message: string): Promise<ProjectPublished> {
  return translated(api.historyProjectPublishBranch(handle, message));
}

/**
 * Commits the saved diagram to the current branch, only if HEAD is still `expectedHead` and nothing
 * makes it surprising; a `RemoteHistoryError` with a `ProjectRefusalReason` otherwise.
 */
export function commitToCurrentBranch(api: DesktopApi, handle: Handle, message: string, expectedHead: Oid): Promise<ProjectPublished> {
  return translated(api.historyProjectCommitCurrent(handle, message, expectedHead));
}

/** Every commit pushing `branch` would publish, the person's own included. */
export function previewProjectPush(api: DesktopApi, handle: Handle, branch: string): Promise<ProjectPushPreview> {
  return translated(api.historyProjectPushPreview(handle, branch));
}

export function pushProjectBranch(api: DesktopApi, handle: Handle, branch: string): Promise<void> {
  return translated(api.historyProjectPush(handle, branch));
}
