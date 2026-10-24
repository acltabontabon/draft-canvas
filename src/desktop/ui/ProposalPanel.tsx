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
import { useNodiShown } from '../nodiShown';
import { useDesktopController } from '../useDesktop';
import { revealViewport } from './chipPlace';
import { ProposalHistory } from './ProposalHistory';
import { reviewRows } from './reviewRows';
import { useProposalReview, type ProposalChanged } from './useProposalReview';

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
  // The proposal the companion's chip is showing is reviewed there; the badge counts the rest. Only
  // a conversation's latest turn has a chip: an earlier turn's proposal, left unanswered when the
  // person asked again, would otherwise have had no way in at all. Nor has any, with Nodi switched
  // off. One whose conversation is gone (a reload, a new conversation) is the badge's again.
  const conversations = useSyncExternalStore(companion.subscribe, companion.snapshot);
  const nodi = useNodiShown();
  const inCompanion = useMemo(() => new Set(nodi ? [...conversations.values()].map((c) => c.turns.at(-1)?.proposalId) : []), [conversations, nodi]);
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
  // The open proposal has its own full summary; repeating it in navigation competes with the review.
  const others = proposals.filter((p) => p.proposalId !== selected?.proposalId);
  const toReview = others.filter((p) => p.status === 'pending' || p.status === 'accepting');
  const history = others.filter((p) => p.status !== 'pending' && p.status !== 'accepting');
  const proposalRows = (items: Proposal[]) => (
    <div className="dc-proposal-list" role="list">
      {items.map((p) => (
        <button
          key={p.proposalId}
          type="button"
          role="listitem"
          className="dc-proposal-row"
          title={`${statusLabel(p.status)}: ${p.summary}`}
          onClick={() => setOpen(true, p.proposalId)}
        >
          <span className="dc-proposal-status" data-status={p.status} role="img" aria-label={statusLabel(p.status)}>
            {p.status === 'accepted' ? '✓' : p.status === 'rejected' ? '×' : p.status === 'pending' || p.status === 'accepting' ? '○' : '−'}
          </span>
          <span className="dc-proposal-row-summary">{p.summary}</span>
        </button>
      ))}
    </div>
  );

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
          {toReview.length > 0 && (
            <div className="dc-proposal-queue">
              <p className="dc-proposal-section-title">Also to review · {toReview.length}</p>
              {proposalRows(toReview)}
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
          {history.length > 0 && (
            <details className="dc-proposal-past">
              <summary>History · {history.length}</summary>
              {proposalRows(history)}
            </details>
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
      <div className="dc-proposal-detail-content">
        <div className="dc-proposal-detail-head">
          <span className="dc-proposal-status-pill" data-status={proposal.status}>
            {statusLabel(proposal.status)}
          </span>
          <p className="dc-proposal-summary">{proposal.summary}</p>
          {!informational && !decided && proposal.counts.added + proposal.counts.updated + proposal.counts.removed > 0 && (
            <ul className="dc-proposal-counts" aria-label="Proposed changes">
              {/* Only what changes: "0 removed" is one more thing to read for nothing. */}
              {proposal.counts.added > 0 && (
                <li className="dc-proposal-count dc-proposal-count-added">
                  <span aria-hidden="true">+</span> <strong>{proposal.counts.added}</strong> added
                </li>
              )}
              {proposal.counts.updated > 0 && (
                <li className="dc-proposal-count dc-proposal-count-modified">
                  <span aria-hidden="true">~</span> <strong>{proposal.counts.updated}</strong> changed
                </li>
              )}
              {proposal.counts.removed > 0 && (
                <li className="dc-proposal-count dc-proposal-count-removed">
                  <span aria-hidden="true">−</span> <strong>{proposal.counts.removed}</strong> removed
                </li>
              )}
            </ul>
          )}
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
        <div className="dc-proposal-detail-scroll">
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
                <div className="dc-proposal-changes">
                  {(['added', 'modified', 'removed'] as const).map((change) => {
                    const rows = readable.rows.filter((row) => row.change === change);
                    if (rows.length === 0) return null;
                    const label = change === 'modified' ? 'Changed' : change === 'added' ? 'Added' : 'Removed';
                    return (
                      <section key={change} className="dc-proposal-diff-group" aria-label={label}>
                        <h3 className="dc-proposal-section-title">{label} · {rows.length}</h3>
                        <ul className="dc-proposal-diff" role="list">
                          {rows.map((row) => {
                            const kind = row.kind === 'element' ? 'Shape' : row.kind === 'group' ? 'Boundary' : row.kind === 'relationship' ? 'Connector' : row.kind;
                            return (
                              <li key={`${row.kind}-${row.id}-${row.path?.join('/') ?? ''}`} className={`dc-proposal-diff-row dc-proposal-diff-${row.change}`}>
                                <span className="dc-proposal-diff-change">{kind}</span>
                                <span className="dc-proposal-diff-label">{row.label || `Unnamed ${kind.toLowerCase()}`}</span>
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
                            );
                          })}
                        </ul>
                      </section>
                    );
                  })}
                  {/* Under its own heading: below the last group, it read as one of its changes. */}
                  {readable.layout && (
                    <section className="dc-proposal-diff-group" aria-label="Layout">
                      <h3 className="dc-proposal-section-title">Layout</h3>
                      <div className="dc-proposal-diff-row dc-proposal-diff-modified">
                        <span className="dc-proposal-diff-label">{readable.layout}</span>
                      </div>
                    </section>
                  )}
                  {diff.length === 0 && <p className="dc-muted">No changes touch {targetsCurrentView ? 'the current view' : breadcrumb}.</p>}
                </div>
              )}
            </>
          )}
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
          <ProposalHistory proposal={proposal} />
          {error && (
            <p className="dc-proposal-banner dc-proposal-banner-conflict" role="alert">
              {error}
            </p>
          )}
        </div>
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
