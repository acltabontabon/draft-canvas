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
  ellipseWidth: 132,
  ellipseHeight: 132,
  groupWidth: 420,
  groupHeight: 300,
  actorWidth: 120,
  actorHeight: 92,
  /** Taller than a plain node — the tube is a compact glyph anchored to the
   *  top, so the label and the kind caption both need their own room below
   *  it, the same reason an actor gets its own taller default too. */
  queueHeight: 88,
} as const;
