/** Maps the 0..1 `blur` setting to a blur radius in CSS/SVG units. */
export function blurRadiusFor(blur: number): number {
  return blur * 16;
}
