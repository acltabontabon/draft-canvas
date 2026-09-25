import { useEffect, useMemo, useState } from 'react';
import { useReactFlow, useStore as useReactFlowStore } from '@xyflow/react';
import { diffForReview, looksAlreadyApplied, preconditionConflicts, type ElementDiffRow } from '../../agent/proposal';
import { applyUpdate } from '../../agent/patch';
import { AgentError } from '../../agent/errors';
import { agentGhostDiff } from '../../canvas/agentGhostDiff';
import { focusBoundsInView } from '../../commands/search';
import { ownerAt, pathKey, viewOf, type DepthPath } from '../../depth/tree';
import { displayNameFor } from '../../document/factory';
import { boundsOf } from '../../document/geometry';
import type { DraftDocument } from '../../document/types';
import { fileOf, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../../ui/common/Button';
import type { Proposal } from '../api';
import { useDesktopController } from '../useDesktop';

/** The floating panel's own width (`app.css`'s `.dc-proposal-panel`) plus its margin from the edge
 *  — subtracted from the pane width "Focus changes" fits into, so a focused change doesn't land
 *  underneath the panel that just asked to see it. */
const PANEL_RESERVED_WIDTH = 360 + 24;

function statusLabel(status: Proposal['status']): string {
  switch (status) {
    case 'pending':
      return 'Pending review';
    case 'accepting':
      return 'Recovering — needs review';
    case 'accept-failed':
      return 'Needs attention';
    case 'accepted':
      return 'Accepted';
    case 'rejected':
      return 'Rejected';
    case 'dismissed':
      return 'Dismissed';
    case 'informational':
      return 'Informational';
  }
}

function countsLabel(counts: Proposal['counts']): string {
  const parts: string[] = [];
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.updated) parts.push(`${counts.updated} modified`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  return parts.length ? parts.join(' · ') : 'No changes';
}

/** "root → OrderService → checkout flow" — the room a proposal targets, by the label each room's
 *  own owner node carries, not by id. Empty `path` is the top-level diagram itself. */
function pathBreadcrumb(file: DraftDocument, path: DepthPath): string {
  if (path.length === 0) return 'the top-level diagram';
  const labels = path.map((_, i) => {
    const owner = ownerAt(file, path.slice(0, i + 1));
    return owner ? displayNameFor(owner) : '…';
  });
  return labels.join(' → ');
}

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
    return () => {
      window.clearInterval(timer);
      // Belt-and-braces alongside `ProposalDetail`'s own cleanup: a diagram switch must never
      // leave a ghost pointed at the diagram just left.
      useUiStore.getState().setProposalPreview(null);
    };
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
        <Button
          variant="quiet"
          onClick={() => {
            setOpen(false);
            // `ProposalDetail`'s own cleanup does this too on unmount; stated here as well since
            // Close is a named, distinct action from Reject/Dismiss/Hide, not just an unmount side effect.
            useUiStore.getState().setProposalPreview(null);
          }}
        >
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
          {selected && (
            <ProposalDetail
              proposal={selected}
              onChanged={(patch) => {
                // Applied synchronously, in the same tick the action's own result is known — the
                // authoritative record the action itself returned, not a guess. Without this, a
                // person can act, then act again on `proposal.status` that's still what it was
                // before, in the real gap between an accept/resolve landing and the next full
                // `refresh()` (an async round trip) correcting the local copy: the same DUPLICATE_ID
                // dry run that already applied could flash again, and Reject/Dismiss would render
                // clickable against a proposal already `accepted`. `resolveOutcome`'s own
                // idempotent/conflict handling means clicking either then would still be harmless —
                // this closes the confusing moment, not a real risk of a double-apply.
                if (patch) setProposals((prev) => prev.map((p) => (p.proposalId === patch.proposalId ? patch : p)));
                else void refresh();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Called with the authoritative updated record the instant an action's own result is known (an
 *  optimistic, synchronous local update — see `ProposalPanel`'s caller), or with nothing to fall
 *  back to a full background refresh when no such record is available (an error path, or a refusal
 *  whose real cause needs a fresh read to explain). */
type ProposalChanged = (patch?: Proposal) => void;

function ProposalDetail({ proposal, onChanged }: { proposal: Proposal; onChanged: ProposalChanged }) {
  const controller = useDesktopController();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setViewport } = useReactFlow();
  const viewWidth = useReactFlowStore((state) => state.width);
  const viewHeight = useReactFlowStore((state) => state.height);
  const currentPath = useEditorStore((state) => state.path);
  const previewVisible = useUiStore((state) => (state.proposalPreview?.proposalId === proposal.proposalId ? state.proposalPreview.visible : true));
  const setProposalPreviewVisible = useUiStore((state) => state.setProposalPreviewVisible);

  // Recomputed against the live document — never the submit-time snapshot, and never proof by itself
  // that nothing conflicts (see `preconditionConflicts`). Against the whole file and the view the
  // proposal was written for — never the room on screen, which is only the whole file at the top
  // level. Subscribed to the room so an edit re-renders; `fileOf` is cached per room, so reading it
  // here costs nothing.
  useEditorStore((state) => state.document);
  const live = fileOf(useEditorStore.getState());
  const path = proposal.path;
  const pathKeyStr = pathKey(path);
  // Memoized on content, not object identity: `proposal` is refetched from the panel's 15s poll (and
  // every other action's refresh), a fresh object every time even when nothing about it changed, so
  // keying on `proposal.ops`/`.layout`/`.preconditions`/`.path` directly would recompute this dry run
  // — a full simulated patch, then two more full diff passes over it — on every such poll and every
  // unrelated re-render while the panel is open. `proposal.version` only bumps on an actual revise-in-
  // place, and `pathKeyStr` is the path's *content*, so together with `live` (itself stable across
  // renders that don't change the document, at the room this proposal is at) this only ever redoes
  // the work when something that could change its answer actually has.
  const dryRun = useMemo(() => {
    // Skipped while `busy`: an Accept in flight has already committed by the time its own
    // `applyToFile` call returns, but `proposal.status` here is still whatever it was when `act()`
    // was called until the optimistic update lands — recomputing in that window would dry-run this
    // proposal's ops against a document that already contains them, throwing a DUPLICATE_ID that has
    // nothing to do with a real conflict, while the buttons are (separately) still disabled by `busy`.
    if (busy || (proposal.status !== 'pending' && proposal.status !== 'accepting')) {
      return { diff: [] as ElementDiffRow[], conflicts: [] as ReturnType<typeof preconditionConflicts>, dryRunProblem: null as string | null, resultFile: null as DraftDocument | null, conflictingIds: undefined as readonly string[] | undefined };
    }
    try {
      const result = applyUpdate(live, path, proposal.ops, proposal.layout ?? undefined);
      return {
        diff: diffForReview(live, result.file, path),
        conflicts: preconditionConflicts(live, path, proposal.preconditions),
        dryRunProblem: null as string | null,
        resultFile: result.file,
        conflictingIds: undefined as readonly string[] | undefined,
      };
    } catch (error_) {
      return {
        diff: [] as ElementDiffRow[],
        conflicts: [] as ReturnType<typeof preconditionConflicts>,
        dryRunProblem: error_ instanceof AgentError ? error_.message : 'This proposal no longer applies to the current diagram.',
        resultFile: null as DraftDocument | null,
        conflictingIds: error_ instanceof AgentError ? (error_.details?.conflictingIds as readonly string[] | undefined) : undefined,
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `path`'s content is `pathKeyStr`; `proposal.ops`/`.layout`/`.preconditions` only ever change together with `.version` (a revise-in-place) — see the comment above
  }, [live, pathKeyStr, proposal.proposalId, proposal.version, proposal.status, busy]);
  const { diff, conflicts, dryRunProblem, resultFile, conflictingIds } = dryRun;
  const informational = proposal.status === 'informational';
  // Case B of crash recovery (`docs/reference/agent-integration.md`): stuck `accepting`, and the only
  // reason the dry run now fails is that this exact proposal's own ids already exist, matching what
  // it would have set (`looksAlreadyApplied` also checks the live content, not just the id) — the
  // fingerprint of a crash between the document commit and recording it, not a real conflict. Never
  // true for `pending`: only an interrupted Accept can leave a proposal in this position.
  const alreadyApplied = proposal.status === 'accepting' && looksAlreadyApplied(proposal.ops, conflictingIds, viewOf(live, path));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `path`'s content is `pathKeyStr`; see the `dryRun` memo above for why this is keyed on content, not the array's own (churning) reference
  const breadcrumb = useMemo(() => pathBreadcrumb(live, path), [live, pathKeyStr]);
  const targetsCurrentView = pathKey(path) === pathKey(currentPath);

  // The same union of touched shapes the canvas ghost draws — "Focus changes" pans/zooms to
  // exactly what the ghost is showing, never a separate notion of "what changed." `null` while the
  // proposal targets a different room than the one on screen: each room has its own coordinate
  // space, and `ProposalPreviewLayer` already refuses to draw there for the same reason — panning
  // to this room's local coordinates while looking at a different room would land somewhere
  // arbitrary in it, not "off" in a way that reads as a mistake.
  const diffBounds = useMemo(() => {
    if (!resultFile || !targetsCurrentView) return null;
    const before = viewOf(live, path);
    const after = viewOf(resultFile, path);
    const ghost = agentGhostDiff({ nodes: before?.nodes ?? [], edges: before?.edges ?? [] }, { nodes: after?.nodes ?? [], edges: after?.edges ?? [] });
    return boundsOf([...ghost.addedNodes, ...ghost.modifiedNodes, ...ghost.removedNodes, ...ghost.addedGroups, ...ghost.modifiedGroups, ...ghost.removedGroups]);
  }, [resultFile, live, path, targetsCurrentView]);

  const focusChanges = () => {
    if (!diffBounds) return;
    focusBoundsInView({ viewWidth: Math.max(200, viewWidth - PANEL_RESERVED_WIDTH), viewHeight, setViewport }, diffBounds);
  };

  // The canvas ghost mirrors exactly what the text diff above just showed: the same `resultFile`,
  // never a second dry run. Cleared (not merely hidden) the moment this proposal stops being
  // reviewable here — resolved, gone stale past recovery, or deselected/closed (the cleanup runs
  // on every dependency change, including unmount) — so a stale ghost can never outlive its
  // proposal. Only ever touches this proposal's own preview: a sibling `ProposalDetail` render for
  // a different proposal (after switching) sets its own before this one's cleanup can run.
  useEffect(() => {
    const ownsCurrent = () => useUiStore.getState().proposalPreview?.proposalId === proposal.proposalId;
    if (resultFile && !dryRunProblem) {
      const view = viewOf(resultFile, path);
      const previous = useUiStore.getState().proposalPreview;
      const visible = previous && previous.proposalId === proposal.proposalId ? previous.visible : true;
      useUiStore.getState().setProposalPreview({
        proposalId: proposal.proposalId,
        path,
        nodes: view?.nodes ?? [],
        edges: view?.edges ?? [],
        visible,
      });
    } else if (ownsCurrent()) {
      useUiStore.getState().setProposalPreview(null);
    }
    return () => {
      if (ownsCurrent()) useUiStore.getState().setProposalPreview(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `path`'s content is `pathKeyStr`, and `resultFile` is now the memoized `dryRun.resultFile` (stable across renders that don't change its answer) — keying on the array/object references themselves would re-fire (and re-render every ghost consumer) on every unrelated re-render this component gets
  }, [proposal.proposalId, dryRunProblem, resultFile, pathKeyStr]);

  const act = async (run: () => Promise<Proposal | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await run());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const accept = () =>
    act(async () => {
      // Re-check everything immediately before committing — the diagram may have moved since this
      // render; a stale re-render here would otherwise commit against a document already gone stale.
      const state = useEditorStore.getState();
      const file = fileOf(state);
      const beforeRevision = state.revision;
      const result = applyUpdate(file, proposal.path, proposal.ops, proposal.layout ?? undefined);
      const freshConflicts = preconditionConflicts(file, proposal.path, proposal.preconditions);
      if (freshConflicts.length > 0) {
        setError('The diagram changed in a way this proposal conflicts with. Ask the agent to revise it.');
        return undefined;
      }
      const begun = await controller.beginAcceptProposal(proposal.proposalId, proposal.version, proposal.diagramId, proposal.path);
      if (!begun.ok) {
        setError(begun.code === 'PROPOSAL_CHANGED' ? 'This proposal changed since it was opened. Review it again.' : `Couldn’t start accepting it (${begun.code}).`);
        // `PROPOSAL_CHANGED` carries the record as it actually stands now — applying it locally means
        // the next render (and the "review it again" it's being told to do) works from the real
        // current state, not the one this attempt started from.
        return begun.code === 'PROPOSAL_CHANGED' ? begun.proposal : undefined;
      }
      // The one gap `begin_accept`'s own version/identity check can't see: an edit landing in the
      // narrow window between it and this commit. `result` was computed from `file`, the document as
      // of `beforeRevision` — passing that revision lets `applyToFile` refuse atomically, inside the
      // same synchronous pass that would otherwise commit, rather than as a separate check with a gap
      // of its own between "check" and "commit".
      const applied = state.applyToFile(`Applied proposal: ${proposal.summary}`, () => result.file, beforeRevision);
      if (!applied) {
        setError('The diagram changed while this was being accepted. Nothing was committed; review it again.');
        return undefined;
      }
      const resolved = await controller.resolveProposal(proposal.proposalId, 'accepted');
      if (!resolved.ok && resolved.code !== 'ALREADY_RESOLVED') {
        setError('Applied, but the proposal record could not be updated.');
        return undefined;
      }
      // The document already has the change either way (`resolved.ok`, or `ALREADY_RESOLVED` because
      // a retry landed after an earlier attempt's response was lost) — but only `resolved.ok` carries
      // the fresh record `ALREADY_RESOLVED` doesn't; local status stays stale until the next poll then,
      // which is exactly the window `busy` alone doesn't close.
      return resolved.ok ? resolved.proposal : undefined;
    });

  const close = (status: 'rejected' | 'dismissed') =>
    act(async () => {
      const resolved = await controller.resolveProposal(proposal.proposalId, status);
      // Already closed is the outcome asked for; anything else (one mid-accept, say) would otherwise
      // leave the button doing nothing, with no word why.
      if (!resolved.ok && resolved.code !== 'ALREADY_RESOLVED') {
        setError(resolved.code === 'WRONG_STAGE' ? `It can’t be ${status} while it is ${resolved.status}.` : `Couldn’t update it (${resolved.code}).`);
        return undefined;
      }
      return resolved.ok ? resolved.proposal : undefined;
    });
  const reject = () => close('rejected');

  // Case B: nothing to commit — it's already there. `Accepting → Accepted` is already a valid
  // transition on its own (the ordinary path once `begin_accept` has run); this just takes it
  // directly, skipping the dry run and `applyToFile` that would otherwise try to reapply it.
  const markApplied = () =>
    act(async () => {
      const resolved = await controller.resolveProposal(proposal.proposalId, 'accepted');
      if (!resolved.ok && resolved.code !== 'ALREADY_RESOLVED') {
        setError(`Couldn’t record it as applied (${resolved.code}). The diagram itself is unaffected either way.`);
        return undefined;
      }
      return resolved.ok ? resolved.proposal : undefined;
    });
  const dismiss = () => close('dismissed');

  return (
    <div className="dc-proposal-detail">
      <div className="dc-proposal-detail-head">
        <p className="dc-proposal-summary">{proposal.summary}</p>
        <div className="dc-proposal-meta">
          <span className="dc-proposal-status-pill" data-status={proposal.status}>
            {statusLabel(proposal.status)}
          </span>
          {!informational && <span className="dc-muted">{countsLabel(proposal.counts)}</span>}
        </div>
        {path.length > 0 && (
          <p className="dc-muted dc-proposal-path">
            Targets <strong>{breadcrumb}</strong>
            {!targetsCurrentView && ' — open that view to see it on the canvas'}
          </p>
        )}
      </div>

      {!informational && !busy && !dryRunProblem && (
        <div className="dc-proposal-toolbar">
          <label className="dc-proposal-toggle">
            <input type="checkbox" checked={previewVisible} onChange={(e) => setProposalPreviewVisible(e.target.checked)} />
            Show on canvas
          </label>
          <Button variant="quiet" onClick={focusChanges} disabled={!diffBounds}>
            Focus changes
          </Button>
        </div>
      )}
      {!informational && !busy && !dryRunProblem && diff.length > 0 && (
        <ul className="dc-proposal-legend" aria-hidden="true">
          <li className="dc-proposal-legend-item dc-proposal-legend-changed">Added / modified</li>
          <li className="dc-proposal-legend-item dc-proposal-legend-removed">Removed</li>
        </ul>
      )}

      <div className="dc-proposal-detail-scroll">
        {proposal.rationale && (
          <details className="dc-proposal-collapsible">
            <summary>Rationale</summary>
            <p className="dc-muted">{proposal.rationale}</p>
          </details>
        )}
        {proposal.assumptions.length > 0 && (
          <details className="dc-proposal-collapsible">
            <summary>Assumptions</summary>
            <ul>
              {proposal.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </details>
        )}
        {proposal.openQuestions.length > 0 && (
          <details className="dc-proposal-collapsible">
            <summary>Open questions</summary>
            <ul>
              {proposal.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </details>
        )}
        {informational ? (
          <p className="dc-muted">No architectural impact — nothing to accept or reject.</p>
        ) : busy ? (
          <p className="dc-muted">Working…</p>
        ) : (
          <>
            {proposal.stale && !dryRunProblem && conflicts.length === 0 && <p className="dc-proposal-banner dc-proposal-banner-stale">The diagram changed elsewhere since this was submitted (unrelated to this proposal).</p>}
            {conflicts.length > 0 && (
              <p className="dc-proposal-banner dc-proposal-banner-conflict">
                {conflicts.length === 1 ? 'One thing this proposal is about has' : `${conflicts.length} things this proposal is about have`} changed since it was written — ask the agent to revise it.
              </p>
            )}
            {alreadyApplied ? (
              <p className="dc-proposal-banner dc-proposal-banner-stale">This looks like it already applied — the app likely stopped right after committing it, before recording that. The diagram itself needs nothing further; mark it applied to clear this from your review list.</p>
            ) : (
              <>
                {dryRunProblem && <p className="dc-proposal-banner dc-proposal-banner-conflict">{dryRunProblem}</p>}
                {proposal.status === 'accepting' && <p className="dc-proposal-banner dc-proposal-banner-stale">Recovering from an interrupted accept — click Accept to finish, or Dismiss if you'd rather inspect the diagram yourself.</p>}
              </>
            )}
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
                {diff.length === 0 && <li className="dc-muted">No changes touch {targetsCurrentView ? 'the current view' : breadcrumb}.</li>}
              </ul>
            )}
          </>
        )}
        {error && (
          <p className="dc-proposal-banner dc-proposal-banner-conflict" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="dc-proposal-actions">
        {informational ? (
          <Button variant="quiet" disabled={busy} onClick={dismiss}>
            Dismiss
          </Button>
        ) : alreadyApplied ? (
          // Reject makes no sense once the change is already real; Accept would just retry a dry run
          // that's guaranteed to fail the same way. Dismiss stays as a plain escape hatch.
          <>
            <Button variant="quiet" disabled={busy} onClick={dismiss}>
              Dismiss
            </Button>
            <Button variant="solid" disabled={busy} onClick={markApplied}>
              Mark as applied
            </Button>
          </>
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
