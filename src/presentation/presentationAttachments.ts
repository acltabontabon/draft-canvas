/**
 * Which contextual content a presentation step tells — the pure half of Presentation Mode's
 * callouts. Given the flow's resolved steps and the current one, decides whose attachments (if
 * anyone's) are shown alongside the step. No React, no geometry: the canvas layer anchors and
 * places whatever this returns, and `FlowBar` reads the same answer for its screen-reader status.
 */
import type { Attachment, DraftEdge, DraftNode } from '../document/types';
import type { FlowPlaybackStep } from './useFlowPlayback';

export type PresentationHostKind = 'node' | 'edge';

/** A presenter's own click on a chip or badge while presenting — see `uiStore.presentationReveal`. */
export interface PresentationReveal {
  hostKind: PresentationHostKind;
  hostId: string;
  /** Where it was asked for (`presentationScope`) — a reveal from another step, or from before a
   *  flow started, is simply not this one's, even for the render before anything clears it. */
  scope: string;
}

/** The presentation moment a reveal belongs to: one step of one flow, or presenting with none. */
export function presentationScope(playback: { active: boolean; flowId: string | null; step: number }): string {
  return playback.active && playback.flowId ? `${playback.flowId}:${playback.step}` : 'present';
}

/** The reveal, if it was made for this moment. */
export function revealIn(reveal: PresentationReveal | null, scope: string): PresentationReveal | null {
  return reveal && reveal.scope === scope ? reveal : null;
}

/** A presenter's click on an element's chip or badge: ask it to speak, or — asked again — let it go. */
export function toggledReveal(
  current: PresentationReveal | null,
  hostKind: PresentationHostKind,
  hostId: string,
  scope: string,
): PresentationReveal | null {
  const same = current?.scope === scope && current.hostKind === hostKind && current.hostId === hostId;
  return same ? null : { hostKind, hostId, scope };
}

export interface PresentationSubject {
  /** The callout's identity: it enters when this changes, and only then. */
  key: string;
  hostKind: PresentationHostKind;
  hostId: string;
  /** Only attachments with something to say, in the host's own order. */
  attachments: Attachment[];
}

/** An attachment says something only when it has content — an empty note stays silent. */
export function presentableAttachments(attachments: readonly Attachment[] | undefined): Attachment[] {
  return (attachments ?? []).filter((attachment) =>
    attachment.type === 'code' ? Boolean(attachment.code?.trim()) : Boolean(attachment.text?.trim()),
  );
}

/** Every node a step puts on stage: its connectors' endpoints and its spotlighted extras. */
function nodesOnStage(step: FlowPlaybackStep): string[] {
  return [...step.edges.flatMap((edge) => [edge.source, edge.target]), ...step.extraNodes.map((node) => node.id)];
}

function subjectFor(
  scope: string,
  hostKind: PresentationHostKind,
  hostId: string,
  attachments: readonly Attachment[] | undefined,
): PresentationSubject | null {
  const said = presentableAttachments(attachments);
  return said.length > 0 ? { key: `${scope}:${hostKind}:${hostId}`, hostKind, hostId, attachments: said } : null;
}

/**
 * What a presenter's own click shows — also while presenting with no flow playing, where it is the
 * only way a callout appears. `scope` keeps keys distinct per step, so the same element revealed on
 * two steps still enters afresh.
 */
export function revealedSubject(
  scope: string,
  reveal: PresentationReveal,
  nodesById: ReadonlyMap<string, DraftNode>,
  edgesById: ReadonlyMap<string, DraftEdge>,
): PresentationSubject | null {
  const host = reveal.hostKind === 'edge' ? edgesById.get(reveal.hostId) : nodesById.get(reveal.hostId);
  return host ? subjectFor(scope, reveal.hostKind, reveal.hostId, host.attachments) : null;
}

export interface ResolveSubjectInput {
  flowId: string;
  steps: readonly FlowPlaybackStep[];
  /** 1-based, as `flowPlayback.step`. */
  step: number;
  nodesById: ReadonlyMap<string, DraftNode>;
  edgesById: ReadonlyMap<string, DraftEdge>;
  reveal?: PresentationReveal | null;
}

/**
 * Who speaks on this step, in order:
 * 1. a presenter's own reveal — they asked for it;
 * 2. the step's connectors (primary first) — the relationship being explained;
 * 3. nodes the step explicitly spotlights (`extraNodeIds`);
 * 4. the node the primary connector arrives at, but only the first time the flow reaches it —
 *    a node introduces itself once, not on every later step it happens to touch.
 * Null when nobody has anything to say, which leaves Presentation Mode exactly as it was.
 */
export function resolvePresentationSubject({
  flowId,
  steps,
  step,
  nodesById,
  edgesById,
  reveal,
}: ResolveSubjectInput): PresentationSubject | null {
  const current = steps.find((entry) => entry.step === step);
  if (!current) return null;
  const scope = presentationScope({ active: true, flowId, step });
  const subject = (hostKind: PresentationHostKind, hostId: string, attachments: readonly Attachment[] | undefined) =>
    subjectFor(scope, hostKind, hostId, attachments);

  const asked = revealIn(reveal ?? null, scope);
  const revealed = asked ? revealedSubject(scope, asked, nodesById, edgesById) : null;
  if (revealed) return revealed;

  for (const edge of current.edges) {
    const spoken = subject('edge', edge.id, edge.attachments);
    if (spoken) return spoken;
  }
  for (const node of current.extraNodes) {
    const spoken = subject('node', node.id, node.attachments);
    if (spoken) return spoken;
  }

  const arrival = current.edge ? nodesById.get(current.edge.target) : undefined;
  if (!arrival) return null;
  const reachedEarlier = steps.some((entry) => entry.step < step && nodesOnStage(entry).includes(arrival.id));
  return reachedEarlier ? null : subject('node', arrival.id, arrival.attachments);
}

/**
 * The callout in words, for the flow bar's existing step announcement — so a screen reader hears
 * what the presentation shows without a second live region competing with it. Notes are read in
 * full (they are the story); code is only named, never read out symbol by symbol.
 */
export function describePresentationSubject(subject: PresentationSubject): string {
  return subject.attachments
    .map((attachment) => {
      if (attachment.type === 'code') return 'Code attached.';
      const kind = attachment.noteKind ?? 'note';
      return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}: ${attachment.text?.trim()}`;
    })
    .join(' ');
}
