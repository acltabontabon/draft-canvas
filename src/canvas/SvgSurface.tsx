import { memo } from 'react';
import { serialize, type SvgEl } from '../render/svg/element';

interface SvgSurfaceProps {
  width: number;
  height: number;
  children: SvgEl[];
  className?: string;
}

/**
 * Paints a display list onto the canvas.
 *
 * It goes through the same serializer the file exporter uses, rather than
 * building React elements, which is what guarantees that what you see is
 * character-for-character what you get in an exported SVG. Rebuilding this as
 * JSX would create a second renderer to keep in sync, and export parity would
 * quietly rot.
 *
 * The markup is safe to inject: every attribute value is machine-generated and
 * every piece of user text is escaped and stripped of control characters by
 * `serialize`, so a node labelled `<script>alert(1)</script>` is displayed as
 * that literal text. See the "XML escaping" tests in `tests/rendering.test.ts`.
 */
export const SvgSurface = memo(function SvgSurface({
  width,
  height,
  children,
  className,
}: SvgSurfaceProps) {
  const markup = children.map(serialize).join('');
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
});
