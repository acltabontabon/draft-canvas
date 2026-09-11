/**
 * The Sequence Diagram export's renderer-agnostic intermediate representation.
 *
 * A `SequenceModel` is derived, never persisted: `build.ts`'s `buildSequenceModel` is the only
 * thing that produces one, from the whole live document — every *playable* Flow, aggregated into
 * one coherent diagram (see `docs/ARCHITECTURE.md`). Mermaid (`mermaid.ts`) and PlantUML
 * (`plantuml.ts`) are the only two consumers; both are pure, independent `SequenceModel -> string`
 * functions that must never re-derive semantics of their own. There is no preview renderer in this
 * app — Draft Canvas generates sequence *source*, not a rendered diagram.
 */
import type { Accent, CodeLanguage, NoteKind } from '../document/types';
import type { NodeCategory } from '../document/connectorSemantics';

/** The three message shapes V1 represents — a deliberately small, closed set. Draft Canvas's Flow
 *  model has no branching/looping semantics today, so there is nothing to bucket beyond this. */
export type InteractionKind = 'sync' | 'async' | 'response';

/** Mermaid only distinguishes actor/participant; PlantUML also has database/queue keywords. Both
 *  exporters derive their own declaration keyword from this one shared, coarser vocabulary. */
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
   * The identifier actually written into Mermaid/PlantUML source (`participant "Label" as
   * <alias>`, and every arrow). A readable, collision-safe slug derived from `label` — see
   * `alias.ts`'s `aliasFor` (e.g. `PaymentService`, `PaymentService2` on a second collision).
   * Falls back to `id` when the label has no usable characters, starts with a digit, or the slug
   * collides case-insensitively with a Mermaid/PlantUML reserved word.
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
  /** Raw, unescaped text — per-format escaping happens in mermaid.ts/plantuml.ts, never here, so
   *  the model itself stays format-agnostic. Never empty. */
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
 * message. One shape for all five: they differ only in an optional portable text prefix (driven by
 * `noteKind`) or an optional source language (`language`, Code only). Mermaid renders it collapsed
 * to one line; PlantUML renders it as a real multi-line block — see `mermaid.ts`/`plantuml.ts`.
 */
export interface SequenceNote {
  kind: 'note';
  order: number;
  /** One participant id -> `Note over A`; two -> `Note over A,B`. Never more than two. */
  participantIds: [string] | [string, string];
  /** Raw, unescaped, multi-line-capable text. */
  text: string;
  /** Present only when this note came from a `note`-type node/attachment — drives the
   *  `"Question: "`/`"Warning: "`/`"Decision: "` prefix. Absent for a Code annotation, and absent
   *  (or `'note'`) for a plain Note (no prefix). */
  noteKind?: NoteKind;
  /** Present only for a Code annotation. Carried through for a possible future fenced-code
   *  emission; neither renderer uses it for anything beyond "this is code" today. */
  language?: CodeLanguage;
  sourceFlowId: string;
  sourceNodeId?: string;
  sourceEdgeId?: string;
  sourceAttachmentId?: string;
}

/**
 * One Flow's contribution to the aggregated diagram — V1's only structural wrapper, always
 * emitted, even for a single-flow model, so the output's shape stays stable as more flows are
 * added later. Mermaid has no native `group` keyword; `mermaid.ts` renders this as `rect … end`
 * with a synthesized title Note. PlantUML renders it as a native `group <label> … end`.
 */
export interface SequenceGroup {
  kind: 'group';
  id: string;
  label: string;
  sourceFlowId: string;
  children: SequenceElement[];
}

/**
 * Reserved for a future explicit `DraftFlow.relationship` field. NOT constructed by V1's
 * `buildSequenceModel` — no inference heuristic exists or is planned to decide "alt vs. loop vs.
 * plain group" from a flow's name or position (a flow named "Compensation" or "Retry" is not
 * evidence of anything — see `docs/SEMANTICS.md`). Included in the union now so `SequenceElement`
 * is already the right shape: adding real support later means teaching `build.ts` to emit one more
 * variant and teaching both renderers to switch on it — never restructuring `SequenceModel`, never
 * touching `SequenceGroup`/`SequenceMessage`/`SequenceNote`.
 */
export interface SequenceAlternative {
  kind: 'alt';
  branches: { label: string; children: SequenceElement[] }[];
}
export interface SequenceLoop {
  kind: 'loop';
  label: string;
  children: SequenceElement[];
}
export interface SequenceParallel {
  kind: 'par';
  branches: { label: string; children: SequenceElement[] }[];
}
export interface SequenceDivider {
  kind: 'divider';
  label: string;
}

export type SequenceElement =
  | SequenceMessage
  | SequenceNote
  | SequenceGroup
  | SequenceAlternative
  | SequenceLoop
  | SequenceParallel
  | SequenceDivider;

export interface SequenceModel {
  /** The document's own title — header-comment use only (see `mermaid.ts`/`plantuml.ts`), never
   *  parsed back. An aggregated model has no single "flow" to name itself after. */
  title: string;
  participants: SequenceParticipant[];
  /** Top level is zero or more `SequenceGroup`s, one per playable flow that produced at least one
   *  message or note, in `document.flows` array order. Never a bare message/note at the top level
   *  in V1. `alt`/`loop`/`par`/`divider` never appear at any level in V1's output. */
  elements: SequenceElement[];
}
