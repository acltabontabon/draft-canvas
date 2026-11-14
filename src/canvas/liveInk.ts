/**
 * Where the stroke being drawn is painted — `InkLayer` registers its live path here and
 * `useInkInput` writes straight to it, once a frame, so drawing never renders a component.
 */
export const liveInkSurface: { path: SVGPathElement | null } = { path: null };
