import { resolveStyle, type ResolvedStyle } from '../render/style/resolve';
import { useEditorStore } from '../store/editorStore';
import { activeStyleOf, useStyleStore } from '../store/styleStore';
import { usePersonality } from '../theme/usePersonality';

/**
 * The style the open diagram is drawn in. Every canvas component reads it here, so shapes,
 * connectors, arrowheads and previews always agree.
 *
 * A diagram that carries its own style is drawn in it. One that carries none is drawn in the style
 * in use on this device, all of it, the way it has always been drawn in this device's drawing
 * hand. Both selectors read a value that keeps its identity until it changes, so a shape or a
 * connector can hold this without doing any work when something else in the diagram changes.
 */
export function useDiagramStyle(): ResolvedStyle {
  const own = useEditorStore((state) => state.document.style);
  const { preset } = usePersonality();
  const mine = useStyleStore((state) => activeStyleOf(state, preset));
  return resolveStyle(own ?? mine, preset);
}
