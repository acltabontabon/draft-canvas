import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useReactFlow, useStoreApi, useStore as useReactFlowStore } from '@xyflow/react';
import { focusBoundsInView } from '../../commands/search';
import { ownerAt, pathKey, type DepthPath } from '../../depth/tree';
import { displayNameFor } from '../../document/factory';
import type { DraftDocument } from '../../document/types';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../../ui/common/Button';
import type { Proposal } from '../api';
import { companion } from '../companion';
import { useDesktopController } from '../useDesktop';
import { revealViewport } from './chipPlace';
import { ProposalHistory } from './ProposalHistory';
import { reviewRows } from './reviewRows';
import { countsLabel, useProposalReview, type ProposalChanged } from './useProposalReview';

/** The floating panel's own width (`app.css`'s `.dc-proposal-panel`) plus its margin from the edge
 *  — subtracted from the pane width "Focus changes" fits into, so a focused change doesn't land
 *  underneath the panel that just asked to see it. */
const PANEL_RESERVED_WIDTH = 360 + 24;

function decidedNote(status: Proposal['status']): string {
  if (status === 'accepted') return 'Accepted: it is in the diagram.';
  if (status === 'rejected') return 'Rejected: the diagram was left as it was.';
  return 'Dismissed without a decision: the diagram was left as it was.';
}

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
  const [listed, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(false);
  // Bumped by every refresh, every local update and every diagram switch: a list still in flight from
  // before any of them is out of date by the time it lands, and is dropped.
  const request = useRef(0);
  // Only this diagram's: in the render between a switch and the list being cleared, the previous
  // diagram's proposals would otherwise show here, and could be accepted into the wrong diagram.
  const proposals = listed.filter((p) => p.diagramId === diagramId);

  const refresh = async () => {
    const token = ++request.current;
    if (!diagramId) return;
    setLoading(true);
    try {
      const next = await controller.listProposals(diagramId);
      if (token === request.current) setProposals(next);
    } finally {
      if (token === request.current) setLoading(false);
    }
  };

  // Listed when the diagram opens, when the window comes back, and when the shell says a proposal
  // arrived, so the badge's count is right without the panel ever having been opened this session —
  // a person shouldn't have to open it just to learn there's something to review.
  useEffect(() => {
    setProposals([]);
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const stop = controller.onProposalsChanged(() => void refresh());
    return () => {
      window.removeEventListener('focus', onFocus);
      stop();
      // Belt-and-braces alongside `ProposalDetail`'s own cleanup: a diagram switch must never
      // leave a ghost pointed at the diagram just left.
      useUiStore.getState().setProposalPreview(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over diagramId/controller, both stable per render pass
  }, [diagramId]);

  // Polled as well, lightly, only while the panel is open, so whether a proposal went stale stays
  // right while it is looked at. A closed panel's badge is kept right by the triggers above: the shell
  // says when a proposal is saved. Polling for it as well walked every project every 15 s, even with
  // the window hidden in the tray.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
  }, [diagramId, open]);

  const pending = proposals.filter((p) => p.status === 'pending' || p.status === 'accepting');
  // Proposals the companion's card is showing are reviewed there; the badge counts the rest. One whose
  // conversation is gone (a reload, a new conversation) is the badge's again.
  const conversations = useSyncExternalStore(companion.subscribe, companion.snapshot);
  const inCompanion = useMemo(() => new Set([...conversations.values()].flatMap((c) => c.turns.map((t) => t.proposalId))), [conversations]);
  const unreviewed = pending.filter((p) => !inCompanion.has(p.proposalId));
  if (!diagramId) return null;

  if (!open) {
    if (unreviewed.length === 0) return null;
    return (
      <button type="button" className="dc-proposal-badge" onClick={() => setOpen(true, unreviewed[0]?.proposalId ?? null)}>
        {unreviewed.length === 1 ? '1 proposal to review' : `${unreviewed.length} proposals to review`}
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
              key={selected.proposalId}
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
                if (patch) {
                  // A list already in flight predates this record.
                  request.current++;
                  setLoading(false);
                  setProposals((prev) => prev.map((p) => (p.proposalId === patch.proposalId ? patch : p)));
                } else void refresh();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function ProposalDetail({ proposal, onChanged }: { proposal: Proposal; onChanged: ProposalChanged }) {
  const { setViewport } = useReactFlow();
  const useReactFlowStoreApi = useStoreApi();
  const viewWidth = useReactFlowStore((state) => state.width);
  const viewHeight = useReactFlowStore((state) => state.height);
  const previewVisible = useUiStore((state) => (state.proposalPreview?.proposalId === proposal.proposalId ? state.proposalPreview.visible : true));
  const setProposalPreviewVisible = useUiStore((state) => state.setProposalPreviewVisible);
  const { live, path, targetsCurrentView, bounds: diffBounds, busy, error, checking, diff, conflicts, dryRunProblem, informational, alreadyApplied, recoveringAccept, accept, reject, dismiss, markApplied } =
    useProposalReview(proposal, onChanged, 'panel');
  // Accepted, rejected or dismissed: there is nothing left to review, so it reads as a record of what
  // was decided, with no canvas toggles and no actions (they stayed after an accept, still offering
  // Accept and Reject on a proposal already in the diagram).
  const decided = proposal.status === 'accepted' || proposal.status === 'rejected' || proposal.status === 'dismissed';
  const pathKeyStr = pathKey(path);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `path`'s content is `pathKeyStr`; keyed on content, not the array's own (churning) reference
  const breadcrumb = useMemo(() => pathBreadcrumb(live, path), [live, pathKeyStr]);

  // Read as a person reads the diagram: geometry counted into one layout line, boundaries by name.
  const readable = useMemo(() => {
    const names = new Map<string, string>();
    for (const node of live?.nodes ?? []) if (node.text) names.set(node.id, node.text);
    for (const row of diff) if (row.label) names.set(row.id, row.label);
    return reviewRows(diff, (id) => names.get(id));
  }, [diff, live]);

  const focusChanges = () => {
    if (!diffBounds) return;
    focusBoundsInView({ viewWidth: Math.max(200, viewWidth - PANEL_RESERVED_WIDTH), viewHeight, setViewport }, diffBounds);
  };

  // Once, when the change is first worked out: the panel covers the right of the canvas, and a change
  // that re-lays the diagram out runs underneath it. The camera moves only as far as it takes to show
  // it beside the panel (out only if it won't fit); after that it is the person's, and Focus changes
  // brings the change back.
  const framed = useRef(false);
  const setViewportRef = useRef(setViewport);
  setViewportRef.current = setViewport;
  useEffect(() => {
    if (!diffBounds || framed.current || !previewVisible) return;
    framed.current = true;
    const { transform } = useReactFlowStoreApi.getState();
    const viewport = revealViewport(diffBounds, transform, { width: Math.max(200, viewWidth - PANEL_RESERVED_WIDTH), height: viewHeight });
    if (viewport) void setViewportRef.current(viewport, { duration: 320 });
  }, [diffBounds, previewVisible, viewWidth, viewHeight, useReactFlowStoreApi]);

  return (
    <div className="dc-proposal-detail">
      <div className="dc-proposal-detail-head">
        <p className="dc-proposal-summary">{proposal.summary}</p>
        <ProposalHistory proposal={proposal} />
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

      {!informational && !decided && !busy && !checking && !dryRunProblem && (
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
      {!informational && !decided && !busy && !checking && !dryRunProblem && diff.length > 0 && (
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
        ) : checking ? (
          <p className="dc-muted">Checking it against the diagram…</p>
        ) : (
          <>
            {proposal.stale && !decided && !dryRunProblem && conflicts.length === 0 && <p className="dc-proposal-banner dc-proposal-banner-stale">The diagram changed elsewhere since this was submitted (unrelated to this proposal).</p>}
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
            {decided && <p className="dc-muted">{decidedNote(proposal.status)}</p>}
            {!decided && !dryRunProblem && (
              <ul className="dc-proposal-diff" role="list">
                {readable.layout && (
                  <li className="dc-proposal-diff-row dc-proposal-diff-modified">
                    <span className="dc-proposal-diff-change">layout</span>
                    <span className="dc-proposal-diff-label">{readable.layout}</span>
                  </li>
                )}
                {readable.rows.map((row) => (
                  <li key={`${row.kind}-${row.id}-${row.path?.join('/') ?? ''}`} className={`dc-proposal-diff-row dc-proposal-diff-${row.change}`}>
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

      {!decided && (
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
              {!recoveringAccept && (
                <Button variant="danger" disabled={busy} onClick={reject}>
                  Reject
                </Button>
              )}
              <Button variant="quiet" disabled={busy} onClick={dismiss}>
                Dismiss
              </Button>
              <Button variant="solid" disabled={busy || checking || !!dryRunProblem || conflicts.length > 0} onClick={accept}>
                Accept
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
