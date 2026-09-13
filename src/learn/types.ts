import type { CreateEdgeInput, CreateNodeInput } from '../document/factory';
import type { DraftEdge, DraftNode } from '../document/types';

/**
 * Learn's vocabulary. A recipe answers one concrete question ("how do I make a call async?") with a
 * scene first and a sentence second — so the recipe itself is mostly metadata for finding it, and
 * the explaining is done by its `Scene` (see `scenes/`).
 *
 * Everything here is plain data with no React, so the command palette can search recipes without
 * pulling the drawer (or any scene) into its chunk.
 */

export type RecipeCategory = 'shapes' | 'connections' | 'architecture' | 'flows';

/** One key cap. `mod`, `shift`, `alt`, `enter` and the arrows are spelled out and drawn per platform. */
export type KeyName = string;

export interface LearnRecipe {
  id: string;
  title: string;
  /** One short sentence. If it needs a second one, the scene isn't doing its job. */
  summary: string;
  category: RecipeCategory;
  /** Words someone might type instead of the title — "dashed", "fire and forget". */
  keywords: readonly string[];
  /** Key combinations worth knowing, each drawn as a group of caps: `[['mod', 'g']]` → ⌘ G. */
  keys?: readonly (readonly KeyName[])[];
  /** One optional line: an alternative gesture, or what the choice means architecturally. */
  note?: string;
  related?: readonly string[];
  /** When Learn is open and this is selected, the recipe is offered under "Selected". */
  appliesTo?: {
    nodeTypes?: readonly DraftNode['type'][];
    /** Matches `serviceKind` / `queueKind` / `databaseKind` / … on the selected node. */
    kinds?: readonly string[];
    edge?: boolean;
  };
  /** Position in the curated "short version" path on Learn's home, if it's part of it. */
  quickStart?: number;
}

// ---------------------------------------------------------------------------------------- scenes

/** Scene coordinates: a fixed 560 × 350 stage (16:10), scaled to whatever width the drawer has. */
export const SCENE_WIDTH = 560;
export const SCENE_HEIGHT = 350;

export interface ScenePoint {
  x: number;
  y: number;
}

export type SceneNodeSpec = CreateNodeInput & { id: string };
export type SceneEdgeSpec = CreateEdgeInput & { id: string };

export interface SceneCursor extends ScenePoint {
  /** Button held — drawn smaller with a ring, the way a drag reads. */
  down?: boolean;
  /** A click lands this frame: one ripple. */
  click?: boolean;
  /** How long the move to this point takes, in ms (default 480). */
  travel?: number;
}

/** A control inside a mocked popover. Only the one or two that matter to the recipe, never the lot. */
export type SceneControl =
  | { type: 'select'; label: string; value: string; options?: readonly string[]; highlight?: string }
  | { type: 'button'; text: string; icon?: string; pressed?: boolean }
  | { type: 'chip'; text: string; pressed?: boolean; accent?: boolean }
  | { type: 'toggle'; label: string; on: boolean; pressed?: boolean };

/** The product UI a scene borrows for a moment — drawn with the real tokens, cut down to the point. */
export type SceneOverlay =
  | { kind: 'popover'; at: ScenePoint; controls: readonly SceneControl[]; placement?: 'above' | 'below' }
  | { kind: 'keys'; keys: readonly KeyName[]; at?: ScenePoint }
  | { kind: 'picker'; at: ScenePoint; items: readonly string[]; highlight?: string; title?: string }
  | { kind: 'pill'; at: ScenePoint; text: string; keys?: readonly KeyName[] }
  | { kind: 'palette'; query: string; rows: readonly { title: string; hint?: string }[]; highlight?: number }
  | { kind: 'flowbar'; step: number; total: number; caption: string }
  | { kind: 'code'; at: ScenePoint; title: string; lines: readonly string[] }
  | { kind: 'marquee'; at: ScenePoint; width: number; height: number };

/**
 * One beat of a scene. Frames are *patches*: nodes, edges, selection and the cursor carry over to the
 * next frame until changed, while `overlay` and `dim` belong to their own frame only — UI that
 * lingers into the next beat reads as a bug, not as continuity.
 */
export interface SceneFrame {
  /** How long this beat holds, in ms. */
  ms: number;
  /** The step this beat belongs to — consecutive frames sharing a label are one step chip. */
  step?: string;
  add?: { nodes?: readonly SceneNodeSpec[]; edges?: readonly SceneEdgeSpec[] };
  update?: {
    nodes?: Readonly<Record<string, Partial<DraftNode>>>;
    edges?: Readonly<Record<string, Partial<DraftEdge>>>;
  };
  /** Node or edge ids to take away (a node takes its connectors with it). */
  remove?: readonly string[];
  /** Node or edge ids shown as selected; `[]` clears. */
  select?: readonly string[];
  /** The node whose connection handles are showing (a hover, or the start of a drag); `null` hides. */
  handles?: string | null;
  cursor?: SceneCursor | null;
  overlay?: SceneOverlay;
  /** Ids drawn dimmed this beat — a flow lens, a presentation step. */
  dim?: readonly string[];
  /** Nodes being dragged this beat — connectors don't route around them, as on the canvas. */
  moving?: readonly string[];
  /** Ids drawn as a suggestion (Intent Continuation's ghost) rather than as real elements. */
  ghost?: readonly string[];
  /** Attachment chips on a node or connector, by host id. Carries over like selection. */
  chips?: Readonly<Record<string, readonly ('note' | 'code')[]>>;
  /** Edge ids, in order, of the flow whose step badges are showing. Carries over; `[]` hides. */
  flow?: readonly string[];
}

export interface Scene {
  /** Read aloud in place of the animation, and shown as text wherever motion is off. */
  label: string;
  frames: readonly SceneFrame[];
}
