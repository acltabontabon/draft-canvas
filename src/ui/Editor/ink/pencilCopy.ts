import type { PrimitiveTooltipContent } from '../../../lib/presets';
import type { PencilTool } from '../../../store/uiStore';

export const PENCIL_TOOLTIP: PrimitiveTooltipContent = {
  title: 'Pencil',
  description: 'Draw over the diagram — circle, underline, scribble a note.',
  usageHint: 'Smart Ink turns rough boxes, cylinders and arrows into real shapes and connectors. H highlights, E erases.',
  shortcut: 'P',
};

/** What the Pencil button says while it is in hand. */
export function pencilLabel(tool: PencilTool | null, smart: boolean): string {
  if (tool === 'highlighter') return 'Highlighter';
  if (tool === 'eraser') return 'Eraser';
  return smart ? 'Smart ink' : 'Sketch';
}
