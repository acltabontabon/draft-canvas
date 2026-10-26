/** Quiet pen-like connectors: the same proportions on the canvas, in exports and in Sketch. */
export const CONNECTOR_STYLE = {
  lineWidth: 1.5,
  arrowLength: 9,
  arrowWidth: 6,
  /** A shallow cut into the back of a filled head lightens its mass without shortening its tip. */
  arrowNotch: 1.6,
  openArrowWidth: 1.2,
} as const;
