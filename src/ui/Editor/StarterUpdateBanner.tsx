import { useEffect, useState } from 'react';
import { readDismissed, writeDismissed } from '../../gallery';
import { fileOf, useEditorStore } from '../../store/editorStore';
import { useGalleryStore } from '../../store/galleryStore';
import { Button } from '../common/Button';

/**
 * A canvas begun from a gallery starter, when that starter has since changed: a quiet note offering
 * the new version as a canvas of its own. Never an update in place — the canvas is the person's,
 * edits and all. Compared against the gallery already on this device; opening a canvas never
 * reaches the network. Dismissed per canvas and per version, so a later change is offered again.
 */
export function StarterUpdateBanner() {
  const origin = useEditorStore((state) => fileOf(state).metadata.origin);
  const canvasId = useEditorStore((state) => state.document.metadata.id);
  const enabled = useGalleryStore((state) => state.enabled);
  const newer = useGalleryStore((state) => {
    if (!origin) return undefined;
    const starter = state.snapshot?.starters.find((s) => s.id === origin.starter);
    return starter && starter.availability === 'ready' && starter.sha256 !== origin.sha256 ? starter : undefined;
  });
  const [dismissed, setDismissed] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (!origin || !enabled) return;
    void useGalleryStore.getState().load({ refresh: false });
    void readDismissed().then(setDismissed);
  }, [origin, enabled]);

  if (!origin || !newer || !dismissed || dismissed[canvasId] === newer.sha256) return null;

  const dismiss = () => {
    const next = { ...dismissed, [canvasId]: newer.sha256 };
    setDismissed(next);
    void writeDismissed(next);
  };

  return (
    <div className="dc-read-only-banner" role="status">
      <span>The {newer.name} starter has been updated.</span>
      <Button variant="quiet" onClick={() => useGalleryStore.getState().openDialog(newer.id)}>See what’s new</Button>
      <Button variant="quiet" onClick={() => void useGalleryStore.getState().openAsCanvas(newer.id)}>Open the new version</Button>
      <Button variant="quiet" aria-label="Dismiss starter update" onClick={dismiss}>Dismiss</Button>
    </div>
  );
}
