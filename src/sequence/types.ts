/**
 * The Sequence Diagram's renderer-agnostic intermediate representation.
 *
 * A `SequenceModel` is derived, never persisted: `build.ts`'s `buildSequenceModel` is the only
 * thing that produces one, from a `DraftFlow` plus the live document it belongs to. Every output
 * — the custom SVG preview (`layout.ts`), Mermaid (`mermaid.ts`), PlantUML (`plantuml.ts`) — is an
 * independent, pure consumer of this same model. Nothing in this file (or this module) imports
 * React or knows about Mermaid/PlantUML syntax.
 */
import type { Accent } from '../document/types';
import type { NodeCategory } from '../document/connectorSemantics';

/** The three message shapes V1 represents — a deliberately small, closed set. Draft Canvas's Flow
 *  model has no branching/looping semantics today, so there is nothing to bucket beyond this. */
export type InteractionKind = 'sync' | 'async' | 'response';

/** Mermaid only distinguishes actor/participant; PlantUML also has database/queue keywords. Both
 *  exporters derive their own declaration keyword from this one shared, coarser vocabulary. */
export type ParticipantKind = 'actor' | 'database' | 'queue' | 'participant';

export interface SequenceParticipant {
  /** Stable machine alias ('P1', 'P2', … in first-appearance order). Exporters reference
   *  participants by this, never by `label` — a rename or a duplicate display name can never
   *  corrupt generated Mermaid/PlantUML text. */
  id: string;
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

export interface SequenceMessage {
  /** Position in the rendered sequence — 0-based, stable, gapless. */
  order: number;
  from: string; // SequenceParticipant.id
  to: string; // SequenceParticipant.id
  /** Raw, unescaped text — per-format escaping happens in mermaid.ts/plantuml.ts, never here, so
   *  the model itself stays format-agnostic. Never empty. */
  label: string;
  interaction: InteractionKind;
  /** True for the synthesized reply leg of an edge with `hasResponse: true`. */
  isResponse?: boolean;
  /** The flow's own accent, carried through for the SVG preview only — Mermaid/PlantUML text has
   *  no color concept in this app's exporters, so this is never emitted into either. */
  accent?: Accent;
  /** Every `DraftEdge` id this message was flattened from, in order — length 1 outside junction
   *  flattening. Preserves traceability so metadata is never silently dropped. */
  sourceEdgeIds: string[];
  /** The `DraftFlowStep` id(s) this message came from, in the same order as `sourceEdgeIds`. */
  sourceStepIds: string[];
}

export interface SequenceModel {
  flowId: string;
  flowTitle: string;
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
}
