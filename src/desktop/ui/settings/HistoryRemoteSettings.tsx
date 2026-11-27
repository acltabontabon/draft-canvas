import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { PublishPolicy } from '../../../evolution/contracts';
import { historyService } from '../../../store/evolution/bridge';
import { useEvolutionStore, type RemoteState } from '../../../store/evolution/evolutionStore';
import { Button } from '../../../ui/common/Button';
import { HistorySettings } from '../../../ui/settings/HistorySettings';
import { ChoiceRow, SettingRow, SettingsSection } from '../../../ui/settings/layout';
import type { GitStatus, ProjectPushPreview, ProjectRepoInfo } from '../../historyRemote';
import {
  bringInRemote,
  checkGit,
  commitProjectCurrent,
  connectRemote,
  disconnectRemote,
  fetchNow,
  planProjectPush,
  planPublish,
  POLICIES,
  projectFile,
  projectInfo,
  publishNow,
  publishProjectBranch,
  pushProject,
  remoteMessage,
  remoteOf,
  setPublishedAlternatives,
  setPublishPolicy,
  type PublishPlan,
} from '../../remoteHistory';
import { useDesktopState } from '../../useDesktop';

/**
 * Settings → History on the desktop: the shared page, then its two optional Git features. Each is
 * a separate, plainly named action; nothing here reaches the network until a button says so.
 */
export function DesktopHistorySettings() {
  return (
    <HistorySettings>
      <GitFeatures />
    </HistorySettings>
  );
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function standingText(remote: RemoteState): string {
  switch (remote.kind) {
    case 'none':
      return 'Not connected.';
    case 'not-published':
      return remote.ahead > 0 ? `${plural(remote.ahead, 'revision')} not published yet.` : 'Nothing published yet.';
    case 'publishing':
      return 'Publishing…';
    case 'published':
      return 'The published copy is current.';
    case 'incoming':
      return `${plural(remote.behind, 'revision')} on the remote that this device does not have.`;
    case 'diverged':
      return 'This device and the remote have both changed. Bring in the remote’s revisions, then publish.';
    case 'offline':
      return 'The remote could not be reached.';
    case 'failed':
      return remote.message;
  }
}

/** Which host and path a URL names, for the first-publish preview. */
function destinationOf(url: string): string {
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(url);
  if (scp) return `${scp[1]} · ${scp[2]}`;
  try {
    const parsed = new URL(url);
    return `${parsed.host} · ${parsed.pathname.replace(/^\//, '')}`;
  } catch {
    return url;
  }
}

function GitFeatures() {
  const [git, setGit] = useState<GitStatus | null>(null);
  const repoId = useEvolutionStore((state) => state.repoId);
  useEffect(() => {
    let live = true;
    checkGit()
      .then((status) => live && setGit(status))
      .catch(() => live && setGit({ available: false, version: null, reason: 'Git could not be checked.' }));
    return () => {
      live = false;
    };
  }, []);
  if (!git) return null;
  if (!git.available) {
    return (
      <SettingsSection title="Publishing" description="Publishing history and committing diagrams into project repositories use Git installed on this computer.">
        <p className="dc-prefs-description" role="status">
          {git.reason ?? 'Git was not found.'} Draft Canvas keeps history without it; install Git (2.38 or later) to publish.
        </p>
      </SettingsSection>
    );
  }
  return (
    <>
      <PublishSection key={repoId ?? 'none'} hasHistory={repoId !== null} />
      <ProjectSection />
    </>
  );
}

function PublishSection({ hasHistory }: { hasHistory: boolean }) {
  // `changes` re-reads the alternatives whenever history records or renames something.
  const { remote, altId } = useEvolutionStore(useShallow((state) => ({ remote: state.remote, altId: state.altId, changes: state.changes })));
  const alternatives = historyService().context()?.meta?.alternatives ?? [];
  const [meta, setMeta] = useState(remoteOf);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [plan, setPlan] = useState<PublishPlan | null>(null);

  const run = useCallback(async (work: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const said = await work();
      if (said) setMessage(said);
    } catch (error) {
      setMessage(remoteMessage(error));
    } finally {
      setMeta(remoteOf());
      setBusy(false);
    }
  }, []);

  const description = 'Copy this diagram’s history to a Git repository of your own — on GitHub, GitLab or any Git server — to keep a backup or share it. Your Git sign-in is used; Draft Canvas never stores a password.';
  if (!hasHistory) {
    return (
      <SettingsSection title="Publish history" description={description}>
        <p className="dc-prefs-description">This diagram has no history yet.</p>
      </SettingsSection>
    );
  }

  if (!meta) {
    return (
      <SettingsSection title="Publish history" description={description}>
        <SettingRow
          label="Remote address"
          description="An https:// or SSH address. Connecting sends nothing."
          control={
            <span className="dc-field">
              <input aria-label="Remote address" placeholder="https://github.com/you/architecture.git" spellCheck={false} value={url} onChange={(event) => setUrl(event.target.value)} />
            </span>
          }
        />
        <div className="dc-history-settings-actions">
          <Button variant="solid" disabled={busy || url.trim() === ''} onClick={() => void run(async () => `Connected to ${await connectRemote(url)}.`)}>
            Connect
          </Button>
        </div>
        {message && (
          <p className="dc-prefs-description" role="status">
            {message}
          </p>
        )}
      </SettingsSection>
    );
  }

  const others = alternatives.filter((alt) => !alt.archived && alt.altId !== altId);
  return (
    <SettingsSection title="Publish history" description={description}>
      <SettingRow label="Remote" description={standingText(remote)} control={<span className="dc-muted dc-history-remote-url">{meta.url}</span>} />
      <SettingRow
        label="Publish"
        control={
          <select
            className="dc-select"
            aria-label="When to publish"
            value={meta.policy}
            disabled={busy}
            onChange={(event) => void run(() => setPublishPolicy(event.target.value as PublishPolicy))}
          >
            {POLICIES.map((option) => (
              <option key={option.policy} value={option.policy}>
                {option.label}
              </option>
            ))}
          </select>
        }
        description={POLICIES.find((option) => option.policy === meta.policy)?.description}
      />
      {meta.policy !== 'milestones' &&
        others.map((alt) => (
          <ChoiceRow
            key={alt.altId}
            type="checkbox"
            label={`Also publish “${alt.name}”`}
            checked={meta.publishAlternatives.includes(alt.altId)}
            disabled={busy}
            onChange={(event) => {
              const chosen = new Set(meta.publishAlternatives);
              if (event.target.checked) chosen.add(alt.altId);
              else chosen.delete(alt.altId);
              void run(() => setPublishedAlternatives([...chosen]));
            }}
          />
        ))}
      {plan ? (
        <PublishPreview
          plan={plan}
          busy={busy}
          onCancel={() => setPlan(null)}
          onPublish={() =>
            void run(async () => {
              await publishNow(true);
              setPlan(null);
              return 'Published.';
            })
          }
        />
      ) : (
        <div className="dc-history-settings-actions">
          <Button variant="solid" disabled={busy} onClick={() => void run(async () => setPlan(await planPublish()))}>
            Publish…
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => void run(async () => standingText(await fetchNow()))}>
            Fetch
          </Button>
          {(remote.kind === 'incoming' || remote.kind === 'diverged') && (
            <Button variant="quiet" disabled={busy} onClick={() => void run(async () => (await bringInRemote()).message)}>
              Bring in remote revisions…
            </Button>
          )}
          <Button variant="quiet" disabled={busy} onClick={() => void run(async () => {
            await disconnectRemote();
            return 'Disconnected. Whatever was published stays on the remote.';
          })}>
            Disconnect
          </Button>
        </div>
      )}
      {message && (
        <p className="dc-prefs-description" role="status">
          {message}
        </p>
      )}
    </SettingsSection>
  );
}

function PublishPreview({ plan, busy, onCancel, onPublish }: { plan: PublishPlan; busy: boolean; onCancel: () => void; onPublish: () => void }) {
  const branches = plan.refs.filter((ref) => ref.ref.startsWith('refs/heads/'));
  const milestones = plan.refs.filter((ref) => ref.ref.startsWith('refs/tags/'));
  const outgoing = branches.reduce((sum, ref) => sum + ref.outgoing, 0);
  const current = plan.refs.every((ref) => ref.upToDate);
  return (
    <div className="dc-history-confirm dc-history-publish-preview" role="group" aria-label="Publish preview">
      <span className="dc-prefs-description">
        {plan.first ? 'First publish to ' : 'Publishing to '}
        <strong>{destinationOf(plan.destination)}</strong>
        {current
          ? ': already up to date.'
          : `: ${branches.length > 0 ? `${plural(branches.length, 'branch', 'branches')} with ${plural(outgoing, 'new revision')}` : ''}${branches.length > 0 && milestones.length > 0 ? ' and ' : ''}${milestones.length > 0 ? plural(milestones.length, 'milestone') : ''}${milestones.length > 0 && branches.length === 0 ? ', with every revision they need' : ''}.`}
        {plan.refs.some((ref) => !ref.fastForward && !ref.upToDate) && ' The remote has revisions this device does not: Fetch and bring them in first.'}
      </span>
      {branches.flatMap((ref) => ref.subjects.slice(0, 3)).length > 0 && (
        <ul className="dc-history-publish-subjects">
          {branches.flatMap((ref) => ref.subjects.slice(0, 3)).map((subject, index) => (
            <li key={index}>{subject}</li>
          ))}
        </ul>
      )}
      <Button variant="solid" disabled={busy || current} onClick={onPublish}>
        Publish
      </Button>
      <Button variant="quiet" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function ProjectSection() {
  const { doc } = useDesktopState();
  const [info, setInfo] = useState<ProjectRepoInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [push, setPush] = useState<ProjectPushPreview | null>(null);
  const [confirmCurrent, setConfirmCurrent] = useState(false);
  const file = projectFile();
  const fileKey = file ? `${file.handle}` : '';

  const reload = useCallback(async () => {
    try {
      setInfo(await projectInfo());
    } catch (error) {
      setInfo(null);
      setMessage(remoteMessage(error));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, fileKey]);

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const said = await work();
      if (said) setMessage(said);
    } catch (error) {
      setMessage(remoteMessage(error));
    } finally {
      await reload();
      setBusy(false);
    }
  };

  const description = 'Commit the saved diagram into the Git repository of the project it lives in, next to your code. Separate from history: only the file as saved is committed.';
  if (!file || info === null) {
    return (
      <SettingsSection title="Project repository" description={description}>
        <p className="dc-prefs-description">{!file ? 'Save the diagram to a file inside a Git repository to commit it there.' : (message ?? 'This diagram’s file is not inside a Git repository.')}</p>
      </SettingsSection>
    );
  }
  if (info === undefined) return null;
  if (info.configRefused) {
    return (
      <SettingsSection title="Project repository" description={description}>
        <p className="dc-prefs-description" role="status">
          {info.configRefused}
        </p>
      </SettingsSection>
    );
  }

  const dirty = doc.kind === 'file' && doc.dirty;
  const busyRepo = info.merging || info.rebasing || info.cherryPicking || info.reverting || info.bisecting;
  const currentBlocked =
    info.branch === null
      ? 'HEAD is detached.'
      : busyRepo
        ? 'A merge, rebase or similar is in progress.'
        : info.pathPartiallyStaged
          ? 'The diagram has staged changes of its own.'
          : info.sparseExcluded
            ? 'The diagram is outside the sparse checkout.'
            : info.signingRequired
              ? 'This repository signs commits, which Draft Canvas does not do.'
              : info.filtered
                ? 'Git attributes would convert the file on commit.'
                : info.headOid === null
                  ? 'The repository has no commits yet.'
                  : null;

  return (
    <SettingsSection title="Project repository" description={description}>
      <SettingRow
        label={info.rootName}
        description={`${info.relPath}${info.branch ? ` · on ${info.branch}` : ''}${info.configOverridden.length > 0 ? ` · its ${info.configOverridden.join(', ')} setting${info.configOverridden.length === 1 ? ' is' : 's are'} ignored` : ''}`}
        control={<span />}
      />
      {dirty && <p className="dc-prefs-description">The diagram has unsaved changes. Only what is saved is committed.</p>}
      {push ? (
        <div className="dc-history-confirm" role="group" aria-label="Push preview">
          <span className="dc-prefs-description">
            Push <strong>{push.branch}</strong> to origin: {plural(push.outgoing, 'commit')} no origin branch has yet
            {push.outgoing > 0 && push.subjects.length > 0 ? ', including your own' : ''}.{!push.fastForward && ' origin has commits this branch does not; Draft Canvas never force-pushes.'}
          </span>
          {push.subjects.length > 0 && (
            <ul className="dc-history-publish-subjects">
              {push.subjects.slice(0, 5).map((subject, index) => (
                <li key={index}>{subject}</li>
              ))}
            </ul>
          )}
          <Button variant="solid" disabled={busy || !push.fastForward || push.outgoing === 0} onClick={() => void run(async () => {
            await pushProject(push.branch);
            setPush(null);
            return `Pushed ${push.branch}.`;
          })}>
            Push
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => setPush(null)}>
            Cancel
          </Button>
        </div>
      ) : confirmCurrent ? (
        <div className="dc-history-confirm" role="group" aria-label="Commit to the current branch">
          <span className="dc-prefs-description">
            Commit {info.relPath} to <strong>{info.branch}</strong> as one new commit. Only this file’s entry in the index changes; anything else you staged stays staged, and the commit is refused if the branch moved.
          </span>
          <Button variant="solid" disabled={busy} onClick={() => void run(async () => {
            const done = await commitProjectCurrent(info.headOid!);
            setConfirmCurrent(false);
            return done.changed ? `Committed to ${done.branch}.` : `${done.branch} already has this version.`;
          })}>
            Commit
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => setConfirmCurrent(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="dc-history-settings-actions">
          <Button variant="solid" disabled={busy} onClick={() => void run(async () => {
            const done = await publishProjectBranch();
            return done.changed ? `Committed to ${done.branch}. Your working tree and current branch were not touched.` : `${done.branch} already has this version.`;
          })}>
            Commit to {info.publishBranch}
          </Button>
          <Button variant="quiet" disabled={busy || currentBlocked !== null} title={currentBlocked ?? undefined} onClick={() => setConfirmCurrent(true)}>
            Commit to {info.branch ?? 'current branch'}…
          </Button>
          {info.hasOrigin && (
            <Button variant="quiet" disabled={busy} onClick={() => void run(async () => setPush(await planProjectPush(info.publishBranch)))}>
              Push {info.publishBranch}…
            </Button>
          )}
        </div>
      )}
      {currentBlocked && !confirmCurrent && <p className="dc-prefs-description">Committing to {info.branch ?? 'the current branch'} is unavailable: {currentBlocked}</p>}
      {message && (
        <p className="dc-prefs-description" role="status">
          {message}
        </p>
      )}
    </SettingsSection>
  );
}
