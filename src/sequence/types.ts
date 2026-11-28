/**
 * How a Flow reads as a sequence: a renderer-agnostic intermediate representation.
 *
 * A `SequenceModel` is derived, never persisted: `build.ts`'s `buildSequenceModel` is the only
 * thing that produces one, from the whole live document — every *playable* Flow, aggregated into
 * one coherent reading (see `docs/reference/architecture.md`). `fromFlow.ts` is its consumer: it
 * turns one Flow's group into a native sequence and must never re-derive semantics of its own.
 */
import type { Accent, CodeLanguage, NoteKind } from '../document/types';
import type { NodeCategory } from '../document/connectorSemantics';

/** The three message shapes V1 represents — a deliberately small, closed set. Draft Canvas's Flow
 *  model has no branching/looping semantics today, so there is nothing to bucket beyond this. */
export type InteractionKind = 'sync' | 'async' | 'response';

/** The coarse family a participant is declared in. Mermaid only distinguishes actor from
 *  participant (`mermaidKeyword`); the store and queue families are kept apart for whoever reads
 *  the model. */
export type ParticipantKind = 'actor' | 'database' | 'queue' | 'participant';

export interface SequenceParticipant {
  /**
   * Stable, INTERNAL-ONLY machine key ('P1', 'P2', … in first-appearance order across the whole
   * aggregated walk). Every internal reference (`SequenceMessage.from/to`, `SequenceNote.
   * participantIds`) uses this — never `alias` or `label` — so a rename, a duplicate label, or an
   * alias collision can never corrupt an internal link. Never written into generated text.
   */
  id: string;
  /**
   * A readable, collision-safe slug derived from `label`, fit to be written as an identifier — see
   * `alias.ts`'s `aliasFor` (e.g. `PaymentService`, `PaymentService2` on a second collision).
   * Falls back to `id` when the label has no usable characters, starts with a digit, or the slug
   * collides case-insensitively with a reserved word.
   */
  alias: string;
  /** Display label, via `displayNameFor` — disambiguated with a " (2)" suffix when another
   *  participant in the same model shares the exact same raw name. */
  label: string;
  category: NodeCategory;
  kind: ParticipantKind;
  sourceNodeId: string;
  /** Set only when this participant IS a Junction node, surfaced because its real endpoint
   *  couldn't be losslessly resolved (an ambiguous fan-in/out, or a dangling side) — see
   *  `flatten.ts`. The ordinary, unambiguous case never produces a Junction participant. */
  isJunctionFallback?: boolean;
}

/**
 * A request, a reply, or an async fire — one type, discriminated by `interaction` rather than
 * three separate shapes, since `interaction` already fully determines which arrow glyph either
 * renderer picks and a synthesized reply already tracks itself via `isResponse`.
 */
export interface SequenceMessage {
  kind: 'message';
  /** Position across the WHOLE model (every group, every flow) — 0-based, stable, gapless. */
  order: number;
  from: string; // SequenceParticipant.id
  to: string; // SequenceParticipant.id
  /** Raw, unescaped text — escaping belongs to whoever writes it out, never here, so the model
   *  itself stays format-agnostic. Never empty. */
  label: string;
  interaction: InteractionKind;
  /** True for the synthesized reply leg of an edge with `hasResponse: true`. */
  isResponse?: boolean;
  accent?: Accent;
  /** Which flow (by id) this message belongs to — every message lives in exactly one
   *  `SequenceGroup`; kept here too for cheap traceability without walking back up the tree. */
  sourceFlowId: string;
  /** Every `DraftEdge` id this message was flattened from, in order — length 1 outside junction
   *  flattening. Preserves traceability so metadata is never silently dropped. */
  sourceEdgeIds: string[];
  /** The `DraftFlowStep` id(s) this message came from, in the same order as `sourceEdgeIds`. */
  sourceStepIds: string[];
}

/**
 * A Note, a Question, a Warning, a Decision, or a Code annotation — never a participant, never a
 * message. One shape for all five: they differ only in an optional kind (`noteKind`) or an
 * optional source language (`language`, Code only).
 */
export interface SequenceNote {
  kind: 'note';
  order: number;
  /** One participant id -> `Note over A`; two -> `Note over A,B`. Never more than two. */
  participantIds: [string] | [string, string];
  /** Raw, unescaped, multi-line-capable text. */
  text: string;
  /** Present only when this note came from a `note`-type node/attachment: a Question, a Warning or
   *  a Decision. Absent for a Code annotation, and absent (or `'note'`) for a plain Note. */
  noteKind?: NoteKind;
  /** Present only for a Code annotation: `build.ts` always sets the key on one, even when the
   *  code names no language, so its presence alone says "this is code". */
  language?: CodeLanguage;
  sourceFlowId: string;
  sourceNodeId?: string;
  sourceEdgeId?: string;
  sourceAttachmentId?: string;
}

/**
 * One Flow's contribution to the aggregated diagram — V1's only structural wrapper, always
 * emitted, even for a single-flow model, so the model's shape stays stable as more flows are
 * added later. `fromFlow.ts` finds a Flow's sequence by its group.
 */
export interface SequenceGroup {
  kind: 'group';
  id: string;
  label: string;
  sourceFlowId: string;
  children: SequenceElement[];
}

export type SequenceElement = SequenceMessage | SequenceNote | SequenceGroup;

export interface SequenceModel {
  /** The document's own title. An aggregated model has no single "flow" to name itself after. */
  title: string;
  participants: SequenceParticipant[];
  /** Top level is zero or more `SequenceGroup`s, one per playable flow that produced at least one
   *  message or note, in `document.flows` array order. Never a bare message/note at the top level
   *  in V1. */
  elements: SequenceElement[];
}
