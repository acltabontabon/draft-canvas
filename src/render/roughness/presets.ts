import type { PersonalityPreset } from '../../ui/personality/usePersonality';

export interface PersonalityProfile {
  /** Corner/vertex jitter magnitude, in canvas units. 0 = no change from Clean. */
  outline: number;
  /** Perpendicular mid-segment curve offset, in canvas units — makes a nominally straight run
   *  (a rect's side, a straight-routed connector) read as gently hand-drawn without moving its
   *  endpoints or corners. An independent axis from `outline`, which only perturbs vertices. */
  bow: number;
  /** Corner overshoot/undershoot, in canvas units — adjacent sides drawn slightly past (or short
   *  of) the corner they'd otherwise meet exactly, the way a pen drawn quickly does. 0 = the
   *  technique is off entirely, not just imperceptible. */
  overshoot: number;
  /** 1 = a single stroke; 2 = an extra faint second stroke — connectors always, and select node
   *  primitives via their own `retrace` handling below. */
  strokes: 1 | 2;
  /** Whether a primitive draws a second, independently-seeded outline pass over the first — a
   *  "retraced pencil" look. Which primitives use it is a per-shape decision in
   *  `nodes/describe.ts`, not data carried here. */
  retrace: boolean;
  /** How a directed edge's arrowhead is drawn: `'crisp'` — the shared, preset-independent marker
   *  every edge of a colour reuses (Clean); `'shared-hand'` — the same shared-marker mechanism,
   *  but the marker's own triangle is perturbed by a fixed (not per-edge) seed (Draft);
   *  `'per-edge-hand'` — a per-edge inline hand-drawn path, uniquely seeded per edge, replacing
   *  the marker reference for that edge (Sketch). */
  arrowStyle: 'crisp' | 'shared-hand' | 'per-edge-hand';
  /** Arrowhead wing-asymmetry magnitude — scaled to the arrow's own small size, not `outline`. */
  arrowJitter: number;
}

export const PERSONALITY_PROFILES: Record<PersonalityPreset, PersonalityProfile> = {
  clean: {
    outline: 0,
    bow: 0,
    overshoot: 0,
    strokes: 1,
    retrace: false,
    arrowStyle: 'crisp',
    arrowJitter: 0,
  },
  draft: {
    outline: 0.9,
    bow: 1.6,
    overshoot: 0,
    strokes: 1,
    retrace: false,
    arrowStyle: 'shared-hand',
    arrowJitter: 0.35,
  },
  sketch: {
    outline: 2.2,
    bow: 3.4,
    overshoot: 2.6,
    strokes: 2,
    retrace: true,
    arrowStyle: 'per-edge-hand',
    arrowJitter: 1.1,
  },
};
