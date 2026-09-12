import { useEffect, useRef } from 'react';
import { useUiStore } from '../../store/uiStore';
import { Button } from './Button';
import { useFocusReturn } from './useFocusReturn';

/**
 * The small, contextual ask shown before the very first `navigator.clipboard.readText()` call —
 * only ever triggered by an explicit clipboard action (context-menu/palette Paste; see
 * `lib/clipboardPermission.ts`), never on mount or on tab focus. Deliberately lighter than
 * `Modal.tsx`: no dimmed backdrop, no focus trap — a quiet fixed card, not a legal-document
 * moment. It does take focus and mark itself modal, so the editor's shortcuts wait for the answer.
 */
export function ClipboardPermissionDialog() {
  const request = useUiStore((state) => state.clipboardPermissionRequest);
  const resolve = useUiStore((state) => state.resolveClipboardPermissionRequest);
  const card = useRef<HTMLDivElement>(null);
  // Still a question the user has to answer before anything else happens, so it takes focus (and
  // hands it back) and reads as modal — which is also what stands the editor's shortcuts down.
  useFocusReturn(Boolean(request));
  useEffect(() => {
    if (request) card.current?.focus();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        resolve(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [request, resolve]);

  if (!request) return null;

  return (
    <div
      ref={card}
      className="dc-clipboard-permission"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="dc-clipboard-permission-title"
      tabIndex={-1}
    >
      <p id="dc-clipboard-permission-title" className="dc-clipboard-permission-title">
        Paste from your clipboard?
      </p>
      <p>Draft Canvas can read your clipboard when you paste content onto the canvas — for example, text or copied images.</p>
      <p className="dc-clipboard-permission-note">Your clipboard stays in your browser and isn't uploaded anywhere.</p>
      <div className="dc-clipboard-permission-actions">
        <Button variant="ghost" onClick={() => resolve(false)}>
          Not now
        </Button>
        <Button variant="solid" onClick={() => resolve(true)}>
          Allow clipboard access
        </Button>
      </div>
    </div>
  );
}
