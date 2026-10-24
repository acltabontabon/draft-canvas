import { useEffect, useMemo, useRef, useState } from 'react';
import { diffForReview, looksAlreadyApplied, preconditionConflicts, type ElementDiffRow } from '../../agent/proposal';
import { applyUpdate } from '../../agent/patch';
import { changedIds } from '../../agent/rebase';
import { AgentError } from '../../agent/errors';
import { runOffThread } from '../../agent/offThread';
import { agentGhostDiff } from '../../canvas/agentGhostDiff';
import { pathKey, viewOf } from '../../depth/tree';
import { boundsOf } from '../../document/geometry';
import type { DraftDocument } from '../../document/types';
import { fileOf, isInteracting, useEditorStore } from '../../store/editorStore';
import { useUiStore, type ProposalPreview } from '../../store/uiStore';
import type { Proposal } from '../api';
import { useDesktopController } from '../useDesktop';

/** How long the diagram must stay still before a proposal is checked against it again. */
const DRY_RUN_SETTLE_MS = 300;

/** Called with the authoritative updated record the instant an action's own result is known (an
 *  optimistic, synchronous local update — see `ProposalPanel`'s caller), or with nothing to fall
 *  back to a full background refresh when no such record is available (an error path, or a refusal
 *  whose real cause needs a fresh read to explain). */
export type ProposalChanged = (patch?: Proposal) => void;

/** Which surface reviews a proposal: the review panel, or the companion's card. Each draws and clears
 *  only its own canvas preview, so one closing never removes the other's. */
export type ReviewOwner = NonNullable<ProposalPreview['owner']>;

/** A proposal checked against the diagram: what applying it would change, and whether it can be. */
interface DryRun {
  /** The proposal and path it was worked out for (see `dryRunKey`). */
  key: string;
  /** The file it was worked out against. */
  base: DraftDocument | null;
  diff: ElementDiffRow[];
  conflicts: ReturnType<typeof preconditionConflicts>;
  dryRunProblem: string | null;
  resultFile: DraftDocument | null;
  conflictingIds: readonly string[] | undefined;
}

const NO_DRY_RUN: DryRun = { key: '', base: null, diff: [], conflicts: [], dryRunProblem: null, resultFile: null, conflictingIds: undefined };

/** The same simulated patch Accept makes (`applyUpdate`, through the worker's `update` job), never committed. */
async function dryRunOf(base: DraftDocument, proposal: Proposal): Promise<Omit<DryRun, 'key'>> {
  const path = proposal.path;
  try {
    const result = await runOffThread({ kind: 'update', file: base, path, ops: proposal.ops, layout: proposal.layout ?? undefined, scope: proposal.scope ?? undefined });
    if (result.kind !== 'update') throw new AgentError('INTERNAL', 'The proposal could not be checked.');
    return {
      base,
      diff: diffForReview(base, result.file, path),
      conflicts: preconditionConflicts(base, path, proposal.preconditions),
      dryRunProblem: result.quality.errors.length ? 'This proposal would leave unreadable content.' : null,
      resultFile: result.file,
      conflictingIds: undefined,
    };
  } catch (error_) {
    return {
      ...NO_DRY_RUN,
      base,
      dryRunProblem: error_ instanceof AgentError ? error_.message : 'This proposal no longer applies to the current diagram.',
      conflictingIds: error_ instanceof AgentError ? (error_.details?.conflictingIds as readonly string[] | undefined) : undefined,
    };
  }
}

export function countsLabel(counts: Proposal['counts']): string {
  const parts: string[] = [];
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.updated) parts.push(`${counts.updated} modified`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  return parts.length ? parts.join(' · ') : 'No changes';
}

/** Whether `preview` is `owner`'s preview of `proposalId`. */
function owns(preview: ProposalPreview | null, proposalId: string, owner: ReviewOwner): boolean {
  return preview?.proposalId === proposalId && (preview.owner ?? 'panel') === owner;
}

/**
 * Everything it takes to review one proposal, for the review panel and the companion's card alike:
 * a dry run against the live diagram, its canvas ghost, and Accept, Reject, Dismiss and Mark as
 * applied. Accept is the one `applyToFile` that commits a proposal, wherever it is clicked.
 */
export function useProposalReview(proposal: Proposal, onChanged: ProposalChanged, owner: ReviewOwner) {
  const controller = useDesktopController();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recomputed against the live document — never the submit-time snapshot, and never proof by itself
  // that nothing conflicts (see `preconditionConflicts`). Against the whole file and the view the
  // proposal was written for — never the room on screen, which is only the whole file at the top
  // level. Subscribed to the room so an edit re-renders; `fileOf` is cached per room, so reading it
  // here costs nothing.
  useEditorStore((state) => state.document);
  const live = fileOf(useEditorStore.getState());
  const path = proposal.path;
  const pathKeyStr = pathKey(path);
  // Keyed on content, not object identity: `proposal` is refetched by the panel's poll (and every
  // other action's refresh), a fresh object every time even when nothing about it changed, so keying
  // on `proposal.ops`/`.layout`/`.preconditions`/`.path` directly would redo this dry run — a full
  // simulated patch, then two more full diff passes over it — on every such poll. `proposal.version`
  // only bumps on an actual revise-in-place, and `pathKeyStr` is the path's *content*.
  const dryRunKey = `${proposal.proposalId}:${proposal.version}:${pathKeyStr}`;
  // Skipped while `busy`: an Accept in flight has already committed by the time its own
  // `applyToFile` call returns, but `proposal.status` here is still whatever it was when `act()`
  // was called until the optimistic update lands — recomputing in that window would dry-run this
  // proposal's ops against a document that already contains them, throwing a DUPLICATE_ID that has
  // nothing to do with a real conflict, while the buttons are (separately) still disabled by `busy`.
  const reviewable = !busy && (proposal.status === 'pending' || proposal.status === 'accepting');
  const [checked, setChecked] = useState<DryRun | null>(null);
  // The simulated patch runs on the agent worker, not the page, and only once the diagram has been
  // still for a moment: run synchronously on every document change it froze the canvas through a
  // drag or a burst of typing while the panel was open. A result for an older document or proposal is
  // dropped when it lands.
  useEffect(() => {
    if (!reviewable) return;
    let current = true;
    const base = live;
    const timer = window.setTimeout(
      () => void dryRunOf(base, proposal).then((result) => current && setChecked({ ...result, key: dryRunKey })),
      checked?.key === dryRunKey ? DRY_RUN_SETTLE_MS : 0,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `proposal`'s content is `dryRunKey` (see above); `checked` only picks the delay
  }, [live, dryRunKey, reviewable]);
  // Until the first check for this proposal lands, nothing about it is known: Accept waits for it.
  const checking = reviewable && checked?.key !== dryRunKey;
  const dryRun = reviewable && checked && !checking ? checked : NO_DRY_RUN;
  const { diff, conflicts, dryRunProblem, conflictingIds } = dryRun;
  // Worked out against a diagram that has since changed: its text stands until the next check lands
  // (Accept checks again anyway), but its ghost would be drawn over shapes that have moved on.
  const resultFile = dryRun.base === live ? dryRun.resultFile : null;
  const informational = proposal.status === 'informational';
  // Case B of crash recovery (`docs/reference/agent-integration.md`): stuck `accepting`, and the only
  // reason the dry run now fails is that this exact proposal's own ids already exist, matching what
  // it would have set (`looksAlreadyApplied` also checks the live content, not just the id) — the
  // fingerprint of a crash between the document commit and recording it, not a real conflict. Never
  // true for `pending`: only an interrupted Accept can leave a proposal in this position.
  const alreadyApplied = proposal.status === 'accepting' && looksAlreadyApplied(proposal.ops, conflictingIds, viewOf(live, path));
  // The backend's own state machine (`resolve_outcome` in `src-tauri/src/commands/agent.rs`) only
  // allows `Accepting → Accepted` or `Accepting → Dismissed`; `Accepting → Rejected` is refused as
  // `WRONG_STAGE`. Offering Reject would be a dead-end action dressed up as a real recovery choice.
  const recoveringAccept = proposal.status === 'accepting' && !alreadyApplied;
  const currentPath = useEditorStore((state) => state.path);
  const targetsCurrentView = pathKeyStr === pathKey(currentPath);

  // The same union of touched shapes the canvas ghost draws — what "Focus changes" and "Show me" frame,
  // never a separate notion of "what changed." `null` while the proposal targets a different room than
  // the one on screen: each room has its own coordinate space, and `ProposalPreviewLayer` already
  // refuses to draw there for the same reason — panning to this room's local coordinates while looking
  // at a different room would land somewhere arbitrary in it.
  const bounds = useMemo(() => {
    if (!resultFile || !targetsCurrentView) return null;
    const before = viewOf(dryRun.base ?? live, path);
    const after = viewOf(resultFile, path);
    const ghost = agentGhostDiff({ nodes: before?.nodes ?? [], edges: before?.edges ?? [] }, { nodes: after?.nodes ?? [], edges: after?.edges ?? [] });
    // A moved shape touches where it stands now as well as where it goes: the tracing sheet trails
    // from one to the other, and the chip must cover neither.
    const was = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
    const modified = [...ghost.modifiedNodes, ...ghost.modifiedGroups];
    const from = modified.flatMap((n) => was.get(n.id) ?? []);
    return boundsOf([...ghost.addedNodes, ...modified, ...from, ...ghost.removedNodes, ...ghost.addedGroups, ...ghost.removedGroups]);
  }, [resultFile, dryRun.base, live, path, targetsCurrentView]);

  // The canvas ghost mirrors exactly what the text diff just showed: the same `resultFile`, never a
  // second dry run. Cleared (not merely hidden) the moment this proposal stops being reviewable here —
  // resolved, gone stale past recovery, or deselected/closed (the cleanup runs on every dependency
  // change, including unmount) — so a stale ghost can never outlive its proposal. Only ever touches
  // this surface's own preview of this proposal: the other surface, or a sibling review of another
  // proposal (after switching), sets its own and this cleanup leaves it alone.
  // Whether the person was looking at the change or at the diagram as it is: kept across the clear
  // and rebuild a re-check does (after an edit lands), or "Now" quietly turned back into "Proposed".
  const shownAs = useRef<{ proposalId: string; visible: boolean } | null>(null);
  useEffect(() => {
    const ownsCurrent = () => owns(useUiStore.getState().proposalPreview, proposal.proposalId, owner);
    if (resultFile && !dryRunProblem) {
      const view = viewOf(resultFile, path);
      const previous = useUiStore.getState().proposalPreview;
      const kept = shownAs.current?.proposalId === proposal.proposalId ? shownAs.current.visible : true;
      const visible = previous && previous.proposalId === proposal.proposalId ? previous.visible : kept;
      useUiStore.getState().setProposalPreview({
        proposalId: proposal.proposalId,
        path,
        nodes: view?.nodes ?? [],
        edges: view?.edges ?? [],
        visible,
        owner,
      });
    } else if (ownsCurrent()) {
      useUiStore.getState().setProposalPreview(null);
    }
    return () => {
      if (!ownsCurrent()) return;
      shownAs.current = { proposalId: proposal.proposalId, visible: useUiStore.getState().proposalPreview?.visible ?? true };
      useUiStore.getState().setProposalPreview(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `path`'s content is `pathKeyStr`, and `resultFile` is now the memoized `dryRun.resultFile` (stable across renders that don't change its answer) — keying on the array/object references themselves would re-fire (and re-render every ghost consumer) on every unrelated re-render this component gets
  }, [proposal.proposalId, dryRunProblem, resultFile, pathKeyStr, owner]);

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

  /**
   * The proposal worked out against the diagram as it is right now, or why it can't be accepted now.
   * `unchanged` means the diagram already holds what it would make: nothing to commit, only to record.
   */
  const prepareAccept = (): { error: string } | { revision: number; file: DraftDocument; unchanged: boolean } => {
    // A drag or a text edit in flight would absorb the commit into its own gesture, so `applyToFile`
    // refuses it — after `begin_accept` had already moved the proposal on. Asked before, it is a retry.
    if (isInteracting()) return { error: 'Finish the drag or edit in progress, then accept it again. Nothing was committed.' };
    if (useUiStore.getState().readOnly) return { error: 'This diagram is read-only. Nothing was committed.' };
    const state = useEditorStore.getState();
    const file = fileOf(state);
    // The panel follows the open diagram, but a switch can land while this panel still shows the one
    // left: a proposal is only ever accepted into the diagram it was written for.
    if (file.metadata.id !== proposal.diagramId) return { error: 'This proposal is for a different diagram than the one open now. Nothing was committed.' };
    const result = applyUpdate(file, proposal.path, proposal.ops, proposal.layout ?? undefined, proposal.scope ?? undefined);
    if (result.quality.errors.length) return { error: 'This proposal would leave unreadable content. Ask the agent to revise it.' };
    if (preconditionConflicts(file, proposal.path, proposal.preconditions).length > 0) {
      return { error: 'The diagram changed in a way this proposal conflicts with. Ask the agent to revise it.' };
    }
    // `applyToFile` refuses a change that changes nothing; accepting one is still a decision to record.
    const unchanged = result.file === file || changedIds(file, result.file).size === 0;
    return { revision: state.revision, file: result.file, unchanged };
  };

  const accept = () =>
    act(async () => {
      // Re-check everything immediately before committing — the diagram may have moved since this
      // render; a stale re-render here would otherwise commit against a document already gone stale.
      let ready = prepareAccept();
      if ('error' in ready) {
        setError(ready.error);
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
      // The person may have edited, or begun a drag, while `begin_accept` was in flight: worked out
      // again against what is there now rather than refused, which would leave it mid-accept.
      if (ready.revision !== useEditorStore.getState().revision || isInteracting()) {
        ready = prepareAccept();
        if ('error' in ready) {
          setError(ready.error);
          return begun.proposal;
        }
      }
      if (!ready.unchanged) {
        // The one gap left: an edit landing between the check above and this commit. Passing the
        // revision `ready` was worked out at lets `applyToFile` refuse atomically, inside the same
        // synchronous pass that would otherwise commit.
        const file = ready.file;
        const applied = useEditorStore.getState().applyToFile(`Applied proposal: ${proposal.summary}`, () => file, ready.revision);
        if (!applied) {
          setError('The diagram changed while this was being accepted. Nothing was committed; accept it again.');
          return begun.proposal;
        }
      }
      const resolved = await controller.resolveProposal(proposal.proposalId, 'accepted');
      if (!resolved.ok && resolved.code !== 'ALREADY_RESOLVED') {
        setError(ready.unchanged ? 'The diagram already had this change, but the proposal record could not be updated.' : 'Applied, but the proposal record could not be updated.');
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

  return {
    live,
    path,
    targetsCurrentView,
    bounds,
    busy,
    error,
    checking,
    base: dryRun.base,
    diff,
    conflicts,
    dryRunProblem,
    resultFile,
    informational,
    alreadyApplied,
    recoveringAccept,
    accept,
    reject: () => close('rejected'),
    dismiss: () => close('dismissed'),
    markApplied,
  };
}
