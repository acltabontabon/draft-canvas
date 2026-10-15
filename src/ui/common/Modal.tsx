import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ModalOverlay, Modal as AriaModal, Dialog } from 'react-aria-components';
import { Button } from './Button';
import { Icon } from './Icon';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { trapTab } from './focusTrap';
import { focusReturnTarget } from './useFocusReturn';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Extra class on the panel root — for a caller that needs to restyle its own chrome (e.g. a quieter header) without changing what other `Modal` consumers get. */
  className?: string;
  /** Renders a small back control beside the title instead of navigating away — for a dialog with
   *  its own internal views (see `AboutDialog.tsx`). Lives in the header, not the scrolling body,
   *  so it stays reachable no matter how far the content has scrolled. Omitted everywhere else. */
  onBack?: () => void;
  /** Accessible label for the back control, e.g. "Back to About". Ignored without `onBack`. */
  backLabel?: string;
}

/**
 * Open modals by opening order. Every `Modal` listens on `window` in the capture phase, and
 * `stopPropagation` can't stop a sibling listener on that same target — so without this, Escape in a
 * modal opened from inside another (Secure export's passphrase prompt over Export) closed both.
 * Only the most recently opened one handles keys. The order is taken at first render, not in an
 * effect: effects run child-first, which would rank a nested modal *below* the one containing it.
 */
let modalSequence = 0;
const openModals = new Set<number>();

export function Modal({ title, onClose, children, footer, width = 460, className, onBack, backLabel }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [order] = useState(() => (modalSequence += 1));

  // React Aria hands focus back to whatever had it when the dialog rendered. For a command run from
  // the palette that's the palette's input, gone by the time the dialog closes, and focus fell to
  // `<body>`; the opener the palette handed over (`handOffFocus`) takes it instead. Read during
  // render, before the dialog's own focus lands, and restored a frame after closing: React Aria
  // lifts the app root's `inert` in a later cleanup, and focusing into an inert tree silently fails.
  const [returnTo] = useState(focusReturnTarget);
  useEffect(
    () => () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (returnTo?.isConnected && (!active || active === document.body)) returnTo.focus();
      });
    },
    [returnTo],
  );

  // Layout effects, this one and the key listener below: a dialog has to be listening before it is
  // first painted. After paint, a loaded machine showed the dialog a frame before it heard Escape,
  // and a keyboard user quick enough to press it then found the dialog would not close.
  useLayoutEffect(() => {
    openModals.add(order);
    return () => {
      openModals.delete(order);
    };
  }, [order]);

  // Mount-only: focusing the panel on every re-run of the keydown-listener effect below would
  // steal focus back from whatever's focused inside the modal (e.g. a slider or text field)
  // any time a caller passes a fresh `onClose` identity — which most do, on every render.
  // What the dialog starts focused on: a field inside that took focus through `autoFocus` (applied
  // during commit, before this runs) keeps it — pulling focus to the panel would make the first
  // keystrokes miss the field — otherwise the panel itself. Remembered in a ref so StrictMode's
  // simulated remount (whose cleanup hands focus back to the trigger) lands on the same element.
  const initialFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    if (!initialFocus.current || !root.contains(initialFocus.current)) {
      const active = document.activeElement;
      initialFocus.current = active instanceof HTMLElement && root.contains(active) ? active : root;
    }
    if (document.activeElement !== initialFocus.current) initialFocus.current.focus();
  }, []);

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (Math.max(...openModals) !== order) return;
      // Escape that cancels an IME conversion in one of the dialog's fields isn't "close".
      if (isImeKeyEvent(event)) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      // A basic Tab-trap: without it, Tab can walk focus out of the dialog and into whatever
      // canvas/toolbar chrome sits behind the backdrop — a keyboard user has no way back in short
      // of reopening it.
      if (panel.current) trapTab(event, panel.current);
      // The compatibility Tab policy has already moved focus; Aria must not move it again.
      if (event.defaultPrevented) event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, order]);

  return (
    <ModalOverlay isOpen isKeyboardDismissDisabled isDismissable onOpenChange={(open) => { if (!open) onClose(); }} className="dc-modal-backdrop">
      <AriaModal>
        <Dialog
          ref={panel}
          className={className ? `dc-modal ${className}` : 'dc-modal'}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          style={{ width }}
        >
          <header className="dc-modal-header">
            <div className="dc-modal-header-title">
              {onBack && (
                <button type="button" className="dc-modal-back" onClick={onBack} aria-label={backLabel ?? 'Back'}>
                  <Icon name="back" size={13} />
                </button>
              )}
              <h2>{title}</h2>
            </div>
            <Button icon="close" variant="quiet" onClick={onClose} aria-label="Close" />
          </header>
          <div className="dc-modal-body">{children}</div>
          {footer && <footer className="dc-modal-footer">{footer}</footer>}
        </Dialog>
      </AriaModal>
    </ModalOverlay>
  );
}
