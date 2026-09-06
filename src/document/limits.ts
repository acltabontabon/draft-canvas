/**
 * Hard limits applied to *imported* documents. Anything arriving from a file is
 * untrusted: it may be malformed, hostile, or simply enormous. The importer
 * repairs rather than rejects wherever repair is unambiguous, and these are the
 * boundaries it repairs towards.
 */
export const LIMITS = {
  /** 24 MB of JSON. Well beyond any real diagram, small enough to parse safely. */
  maxFileBytes: 24 * 1024 * 1024,
  maxNodes: 5000,
  maxEdges: 10000,
  maxTitleLength: 200,
  maxTextLength: 20_000,
  maxCodeLength: 200_000,
  maxLabelLength: 500,
  maxIdLength: 128,
  /** Coordinates are clamped to keep the viewport maths well-conditioned. */
  maxCoordinate: 1_000_000,
  minNodeSize: 24,
  maxNodeSize: 20_000,
  minZoom: 0.1,
  maxZoom: 4,
  maxAttachmentsPerNode: 12,
  /** Small on purpose — v1's toolbar and reveal card only ever create or show the first one. */
  maxAttachmentsPerEdge: 4,
  maxFlows: 50,
  maxStepsPerFlow: 200,
  /** Per step, per array (`extraNodeIds`, `extraEdgeIds`) — a "frame" step spotlighting more than this is not a walkthrough anymore. */
  maxExtraMembersPerStep: 40,
  maxFlowTitleLength: 100,
  maxConditionLength: 120,
  maxResponseLength: 120,
} as const;

export const DEFAULTS = {
  nodeWidth: 176,
  nodeHeight: 68,
  codeWidth: 380,
  codeHeight: 180,
  noteWidth: 200,
  noteHeight: 108,
  textWidth: 200,
  textHeight: 36,
  /** A Junction is a routing/convergence point, not a component — kept compact enough to read
   *  as punctuation in the diagram rather than a shape competing with Service/Data Store/Queue. */
  ellipseWidth: 36,
  ellipseHeight: 36,
  groupWidth: 420,
  groupHeight: 300,
  /** Sized to give Actor real presence as a first-class participant — big enough for a clearly
   *  readable glyph and label with proper breathing room, while staying narrower than Service so
   *  the family hierarchy (participant vs. internal component) still reads at a glance. */
  actorWidth: 120,
  actorHeight: 92,
  /** Narrower and taller than the generic node default — a cylinder that wide and short reads
   *  as a stretched database icon rather than a deliberate container shape. */
  dataStoreWidth: 148,
  dataStoreHeight: 88,
  /** The tube is a compact glyph anchored to the top, with only its kind
   *  caption (no editable name — see `defaultTextFor`) sitting snugly below
   *  it — sized to leave just enough margin below the caption for a
   *  top/bottom-anchored connector to meet the node without a visible gap.
   *  Narrower than the standard node width too, now that it's this short —
   *  the full 176px read as a stretched bar around a much smaller glyph. */
  queueWidth: 140,
  queueHeight: 48,
  /** ~13%/~18% smaller than Service's own default (`nodeWidth`/`nodeHeight`) — a deliberate visual
   *  hierarchy, not just a stylistic choice: a Component is meant to read at a glance as something
   *  contained within a larger boundary, never a peer of the deployable/runtime things around it.
   *  Only the *default* differs — an existing or manually resized Component is never touched (see
   *  `document/factory.ts`'s `createNode`, which reads this only when a caller omits `width`/
   *  `height` entirely). */
  componentWidth: 152,
  componentHeight: 56,
} as const;
