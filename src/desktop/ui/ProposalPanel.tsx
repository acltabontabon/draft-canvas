import { useEffect, useState } from 'react';
import { currentRevision } from '../../host/agentBridge';
import { diffForReview, preconditionConflicts, type ElementDiffRow } from '../../agent/proposal';
import { applyUpdate } from '../../agent/patch';
import { AgentError } from '../../agent/errors';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../../ui/common/Button';
import type { Proposal } from '../api';
import { useDesktopController } from '../useDesktop';

/**
 * The one surface for reviewing a coding agent's proposal (Phase 4b) — additions, modifications and
 * removals shown apart (never colour alone), with real before→after field values for a modification,
 * because a proposal's whole point is often a non-geometric change (a label, a note, a relationship's
 * meaning) that a canvas ghost alone can't show. A non-blocking floating panel, following `FlowPanel`'s
 * template rather than a modal: pan, zoom, selection and presentation stay usable while it's open.
 *
 * Never touches the document itself except through the ordinary `applyToFile` commit, on an explicit
 * Accept — the same one-`HistoryEntry` primitive every other edit uses, so undo/redo need nothing new.
 * `proposals.rs`'s own status is a separate store; nothing here (or anywhere) reactivates a resolved
 * proposal, including by undoing an accepted change.
 */
export function ProposalPanel() {
  const open = useUiStore((state) => state.proposalPanelOpen);
  const setOpen = useUiStore((state) => state.setProposalPanelOpen);
  const selectedId = useUiStore((state) => state.proposalPanelId);
  // Read regardless of `open` — the badge that opens this panel has to know there's something to
  // review before the person has ever opened it once.
  const diagramId = useEditorStore((state) => state.document.metadata.id);
  const controller = useDesktopController();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    if (!diagramId) return;
    setLoading(true);
    try {
      setProposals(await controller.listProposals(diagramId));
    } finally {
      setLoading(false);
    }
  };

  // Also polled while closed, lightly, so the badge's count is right without the panel ever having
  // been opened this session — a person shouldn't have to open it just to learn there's something to review.
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over diagramId/controller, both stable per render pass
  }, [diagramId]);

  const pending = proposals.filter((p) => p.status === 'pending' || p.status === 'accepting');
  if (!diagramId) return null;

  if (!open) {
    if (pending.length === 0) return null;
    return (
      <button type="button" className="dc-proposal-badge" onClick={() => setOpen(true, pending[0]?.proposalId ?? null)}>
        {pending.length === 1 ? '1 proposal to review' : `${pending.length} proposals to review`}
      </button>
    );
  }

  const selected = proposals.find((p) => p.proposalId === selectedId) ?? pending[0] ?? null;

  return (
    <div className="dc-proposal-panel" role="region" aria-label="Proposal review">
      <div className="dc-proposal-panel-head">
        <strong>Proposals</strong>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      {loading && proposals.length === 0 ? (
        <p className="dc-muted dc-proposal-empty">Loading…</p>
      ) : proposals.length === 0 ? (
        <p className="dc-muted dc-proposal-empty">No proposals for this diagram.</p>
      ) : (
        <>
          {proposals.length > 1 && (
            <div className="dc-proposal-list" role="list">
              {proposals.map((p) => (
                <button
                  key={p.proposalId}
                  type="button"
                  role="listitem"
                  className="dc-proposal-row"
                  data-selected={p.proposalId === selected?.proposalId}
                  onClick={() => setOpen(true, p.proposalId)}
                >
                  <span>{p.summary}</span>
                  <span className="dc-muted dc-proposal-status">{p.status}</span>
                </button>
              ))}
            </div>
          )}
          {selected && <ProposalDetail proposal={selected} onChanged={refresh} />}
        </>
      )}
    </div>
  );
}

function ProposalDetail({ proposal, onChanged }: { proposal: Proposal; onChanged: () => void }) {
  const controller = useDesktopController();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recomputed fresh against the live document on every render this proposal is shown — never the
  // submit-time snapshot, and never proof by itself that nothing conflicts (see `preconditionConflicts`).
  const live = useEditorStore((state) => state.document);
  const path = useEditorStore((state) => state.path);
  let diff: ElementDiffRow[] = [];
  let conflicts: ReturnType<typeof preconditionConflicts> = [];
  let dryRunProblem: string | null = null;
  if (proposal.status === 'pending' || proposal.status === 'accepting') {
    try {
      const result = applyUpdate(live, path, proposal.ops, proposal.layout ?? undefined);
      diff = diffForReview(live, result.file, path);
      conflicts = preconditionConflicts(live, path, proposal.preconditions);
    } catch (error_) {
      dryRunProblem = error_ instanceof AgentError ? error_.message : 'This proposal no longer applies to the current diagram.';
    }
  }
  const informational = proposal.status === 'informational';

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const accept = () =>
    act(async () => {
      // Re-check everything immediately before committing — the diagram may have moved since this
      // render; a stale re-render here would otherwise commit against a document already gone stale.
      const state = useEditorStore.getState();
      const beforeRevision = currentRevision();
      const result = applyUpdate(state.document, state.path, proposal.ops, proposal.layout ?? undefined);
      const freshConflicts = preconditionConflicts(state.document, state.path, proposal.preconditions);
      if (freshConflicts.length > 0) {
        setError('The diagram changed in a way this proposal conflicts with. Ask the agent to revise it.');
        return;
      }
      const begun = await controller.beginAcceptProposal(proposal.proposalId, proposal.version, proposal.diagramId, proposal.path);
      if (!begun.ok) {
        setError(begun.code === 'PROPOSAL_CHANGED' ? 'This proposal changed since it was opened. Review it again.' : `Couldn’t start accepting it (${begun.code}).`);
        return;
      }
      // The one gap `begin_accept`'s own version/identity check can't see: an edit landing in the
      // narrow window between it and this commit. `applyToFile`'s recipe ignores the file it's handed
      // (the review already recomputed `result` from the exact document being committed against), so
      // this is the only place that would catch it — refuse and let a fresh render show what changed,
      // never commit `result` against a document it was no longer computed from.
      if (currentRevision() !== beforeRevision) {
        setError('The diagram changed while this was being accepted. Nothing was committed; review it again.');
        return;
      }
      const applied = state.applyToFile(`Applied proposal: ${proposal.summary}`, () => result.file);
      if (!applied) {
        setError('The diagram changed while this was being applied. Nothing was committed; try again.');
        return;
      }
      const resolved = await controller.resolveProposal(proposal.proposalId, 'accepted');
      if (!resolved.ok && resolved.code !== 'ALREADY_RESOLVED') {
        setError('Applied, but the proposal record could not be updated.');
      }
    });

  const reject = () => act(async () => void (await controller.resolveProposal(proposal.proposalId, 'rejected')));
  const dismiss = () => act(async () => void (await controller.resolveProposal(proposal.proposalId, 'dismissed')));

  return (
    <div className="dc-proposal-detail">
      <p>{proposal.summary}</p>
      {proposal.rationale && <p className="dc-muted">{proposal.rationale}</p>}
      {proposal.assumptions.length > 0 && (
        <div className="dc-proposal-list-block">
          <strong>Assumptions</strong>
          <ul>
            {proposal.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {proposal.openQuestions.length > 0 && (
        <div className="dc-proposal-list-block">
          <strong>Open questions</strong>
          <ul>
            {proposal.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      {informational ? (
        <p className="dc-muted">No architectural impact — nothing to accept or reject.</p>
      ) : (
        <>
          {proposal.stale && !dryRunProblem && conflicts.length === 0 && <p className="dc-proposal-banner dc-proposal-banner-stale">The diagram changed elsewhere since this was submitted (unrelated to this proposal).</p>}
          {conflicts.length > 0 && (
            <p className="dc-proposal-banner dc-proposal-banner-conflict">
              {conflicts.length === 1 ? 'One thing this proposal is about has' : `${conflicts.length} things this proposal is about have`} changed since it was written — ask the agent to revise it.
            </p>
          )}
          {dryRunProblem && <p className="dc-proposal-banner dc-proposal-banner-conflict">{dryRunProblem}</p>}
          {proposal.status === 'accepting' && <p className="dc-proposal-banner dc-proposal-banner-stale">Recovering from an interrupted accept — click Accept to finish, or Dismiss if you'd rather inspect the diagram yourself.</p>}
          {!dryRunProblem && (
            <ul className="dc-proposal-diff" role="list">
              {diff.map((row) => (
                <li key={`${row.kind}-${row.id}`} className={`dc-proposal-diff-row dc-proposal-diff-${row.change}`}>
                  <span className="dc-proposal-diff-change">{row.change}</span>
                  <span className="dc-proposal-diff-label">{row.label || row.id}</span>
                  {row.fields && (
                    <ul className="dc-proposal-diff-fields">
                      {row.fields.map((f) => (
                        <li key={f.field}>
                          {f.field}: <span className="dc-proposal-diff-before">{f.before ?? '—'}</span> → <span className="dc-proposal-diff-after">{f.after ?? '—'}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
              {diff.length === 0 && <li className="dc-muted">No changes touch the current view.</li>}
            </ul>
          )}
        </>
      )}
      {error && (
        <p className="dc-proposal-banner dc-proposal-banner-conflict" role="alert">
          {error}
        </p>
      )}
      <div className="dc-proposal-actions">
        {informational ? (
          <Button variant="quiet" disabled={busy} onClick={dismiss}>
            Dismiss
          </Button>
        ) : (
          <>
            <Button variant="danger" disabled={busy} onClick={reject}>
              Reject
            </Button>
            <Button variant="quiet" disabled={busy} onClick={dismiss}>
              Dismiss
            </Button>
            <Button variant="solid" disabled={busy || !!dryRunProblem || conflicts.length > 0} onClick={accept}>
              Accept
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
