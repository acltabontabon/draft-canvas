import { useMemo } from 'react';
import type { DraftNode } from '../document/types';
import { describeContext, describeNode } from '../nodes/describe';
import { serialize } from '../render/svg/element';
import { emitDisplayList } from '../render/svg/emit';
import { useThemeValue } from '../ui/theme/useTheme';

/**
 * A miniature, always-clean-preset rendering of a real node shape — the same
 * `describeNode` → `emitDisplayList` → `serialize` pipeline the live canvas
 * and the SVG/PNG exporter already share (see `SvgSurface.tsx`), not a
 * second, hand-drawn icon set. This is what lets a kind picker's preview stay
 * honest: if a shape's geometry in `nodes/describe.ts` changes, every picker
 * showing it updates for free, with nothing to keep in sync by hand.
 *
 * Text is deliberately stripped — a caption or kind label baked into an
 * option row's own tiny icon would just repeat the option's own `label` text
 * at illegible size. The personality preset is always `'clean'` regardless of
 * the document's own setting: a hand-drawn wobble reads as noise, not detail,
 * at 28px.
 */
export function ShapePreview({
  node,
  width = 40,
  height = 26,
}: {
  node: Pick<DraftNode, 'type'> & Partial<DraftNode>;
  width?: number;
  height?: number;
}) {
  const theme = useThemeValue();
  const markup = useMemo(() => {
    const full: DraftNode = {
      id: 'preview',
      x: 0,
      y: 0,
      z: 0,
      width,
      height,
      text: '',
      ...node,
    };
    const ctx = describeContext(theme, 'clean');
    const list = describeNode(full, ctx);
    const shapes = list.shapes.filter((shape) => shape.t !== 'text');
    return emitDisplayList({ ...list, shapes }).map(serialize).join('');
  }, [node, theme, width, height]);

  return (
    <svg
      className="dc-shape-preview"
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
