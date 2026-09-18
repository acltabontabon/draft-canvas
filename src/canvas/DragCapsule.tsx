/**
 * The pill a Note/Code card collapses into while it is being carried somewhere (see
 * `dragCapsule.ts` for *when*).
 *
 * It is deliberately not a new piece of visual vocabulary: it is `.dc-attachment-chip` — the very
 * chip this card becomes the moment it is dropped onto a shape or a connector, down to the accent
 * dot, the language glyph and the label, all from the same `attachmentLookFor`. So the gesture
 * reads as one object changing state (card → identity → attached chip) rather than as a card being
 * swapped for a drag preview and then for something else again.
 *
 * Rendered *inside* the dragged React Flow node, which is what keeps it free: React Flow already
 * moves that node by CSS transform every frame, so the capsule rides along with no per-frame React
 * work at all. `--dc-zoom` (published on React Flow's root by `Canvas.tsx`) cancels the viewport
 * scale so the pill stays the same size on screen at any zoom.
 */
import { memo } from 'react';
import type { CSSProperties } from 'react';
import type { DraftNode } from '../document/types';
import { attachmentLookFor } from './attachmentLook';
import { useThemeValue } from '../ui/theme/useTheme';
import type { DragCapsuleState } from '../store/uiStore';

export const DragCapsule = memo(function DragCapsule({ node, capsule }: { node: DraftNode; capsule: DragCapsuleState }) {
  const theme = useThemeValue();
  const kind = node.type === 'code' ? 'code' : 'note';
  const look = attachmentLookFor(theme, {
    type: kind,
    noteKind: node.noteKind,
    language: node.language,
    accent: node.accent,
  });

  return (
    <span
      className="dc-drag-capsule-anchor"
      aria-hidden="true"
      style={{ left: capsule.offsetX, top: capsule.offsetY }}
    >
      <span
        className="dc-attachment-chip dc-drag-capsule"
        data-kind={kind}
        style={
          {
            ['--dc-chip-fill']: look.fill,
            ['--dc-chip-border']: look.border,
            ['--dc-chip-accent']: look.accent,
            ['--dc-capsule-nudge-x']: `${capsule.nudgeX}px`,
            ['--dc-capsule-nudge-y']: `${capsule.nudgeY}px`,
          } as CSSProperties
        }
      >
        <span className="dc-attachment-chip-icon" aria-hidden="true">
          {kind === 'code' ? '{ }' : ''}
        </span>
        <span className="dc-attachment-chip-label">{look.label}</span>
      </span>
    </span>
  );
});
