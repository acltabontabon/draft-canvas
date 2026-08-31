import { useEffect, useState } from 'react';
import type { BackgroundSettings } from '../document/types';
import { blurRadiusFor } from '../render/backgroundAnchor';
import { getRepository } from '../storage';
import { useUiStore } from '../store/uiStore';

interface CanvasBackgroundProps {
  settings: BackgroundSettings;
  documentId: string;
  /** Presentation Mode dims further, on top of the user's own setting — see `Canvas.tsx`. */
  extraDim?: number;
}

const BACKGROUND_SIZE_CSS: Record<BackgroundSettings['fit'], string> = {
  cover: 'cover',
  contain: 'contain',
  tile: 'auto',
};

/**
 * A decorative, canvas-layer backdrop (Phase 5.1) — never a diagram object.
 * Deliberately fills the visible screen like a wallpaper rather than panning/
 * zooming with the diagram: it is a plain, untransformed sibling of React
 * Flow's own tree (not routed through `ViewportPortal`, which paints *above*
 * nodes/edges and is camera-transformed — used elsewhere for drag-guide
 * chrome), so it always covers the pane with no risk of the diagram panning
 * past its edge. Not selectable, no pointer events, no participation in
 * grouping/routing/keyboard shortcuts — it never appears in `document.nodes`
 * or any node/selection code path.
 */
export function CanvasBackground({ settings, documentId, extraDim = 0 }: CanvasBackgroundProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Bumped by `CanvasSettingsDialog` whenever the blob is replaced — `enabled`
  // alone doesn't change on a "Replace image…" while already enabled, so
  // something else has to signal that the stored bytes are stale.
  const backgroundImageVersion = useUiStore((state) => state.backgroundImageVersion);

  useEffect(() => {
    if (!settings.enabled) {
      // oxlint-disable-next-line set-state-in-effect -- synchronizing with the IndexedDB-backed image below; this early exit just clears it.
      setImageUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void getRepository()
      .then((repository) => repository.loadBackgroundImage(documentId))
      .then((row) => {
        if (cancelled || !row) return;
        objectUrl = URL.createObjectURL(row.blob);
        setImageUrl(objectUrl);
      })
      .catch(() => {
        // A missing/corrupted row degrades to "no background shown," not an error.
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [settings.enabled, documentId, backgroundImageVersion]);

  if (!settings.enabled || !imageUrl) return null;

  const dim = Math.min(1, settings.dim + extraDim);

  return (
    <div className="dc-canvas-background" aria-hidden="true">
      <div
        className="dc-canvas-background-image"
        style={{
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: BACKGROUND_SIZE_CSS[settings.fit],
          backgroundRepeat: settings.fit === 'tile' ? 'repeat' : 'no-repeat',
          backgroundPosition: settings.fit === 'tile' ? '0 0' : 'center',
          filter: settings.blur > 0 ? `blur(${blurRadiusFor(settings.blur)}px)` : undefined,
        }}
      />
      <div className="dc-canvas-background-scrim" style={{ opacity: dim }} />
    </div>
  );
}
