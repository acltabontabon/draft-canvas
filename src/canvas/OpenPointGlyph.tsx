import { useMemo } from 'react';
import type { OpenPointKind } from '../document/types';
import { MARKER_SIZE, describeKindTab } from '../openPoints/marker';
import { beginClipScope, emitDisplayList } from '../render/svg/emit';
import { useThemeValue } from '../ui/theme/useTheme';
import { SvgSurface } from './SvgSurface';

/**
 * One kind's tab, the way the canvas draws it, wherever the product talks about that kind — the
 * kind picker, a row in the overview, a chip in the popover. The same `describeKindTab` the marker
 * and the export use, so the picture is learned once.
 */
export function OpenPointGlyph({ kind, className }: { kind: OpenPointKind; className?: string }) {
  const theme = useThemeValue();
  const shapes = useMemo(() => {
    beginClipScope(`open-point-glyph-${kind}`);
    return emitDisplayList({ width: MARKER_SIZE, height: MARKER_SIZE, shapes: describeKindTab(kind, { theme }) });
  }, [kind, theme]);
  return (
    <SvgSurface className={className ?? 'dc-open-point-kind-glyph'} width={MARKER_SIZE} height={MARKER_SIZE}>
      {shapes}
    </SvgSurface>
  );
}
