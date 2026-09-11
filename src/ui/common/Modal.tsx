import { useEffect, useRef, type ReactNode } from 'react';
import { useFocusReturn } from './useFocusReturn';
import { Button } from './Button';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/** Elements a Tab-trap should stop at — mirrors what a modal in this app actually contains
 *  (buttons, inputs, selects, links); disabled controls are filtered out below since they can't
 *  take focus regardless of matching the selector. */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, footer, width = 460 }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);

  // A `Modal` only ever exists while its caller is showing it — no separate `open` prop — so
  // "active" for the whole focus-return lifecycle is simply "for as long as this is mounted".
  useFocusReturn(true);

  // Mount-only: focusing the panel on every re-run of the keydown-listener effect below would
  // steal focus back from whatever's focused inside the modal (e.g. a slider or text field)
  // any time a caller passes a fresh `onClose` identity — which most do, on every render.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      // A basic Tab-trap: without it, Tab can walk focus out of the dialog and into whatever
      // canvas/toolbar chrome sits behind the backdrop — a keyboard user has no way back in short
      // of reopening it. Wraps at either end rather than blocking Tab outright once it reaches one.
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      // The mount effect above focuses the panel itself first (so a screen reader announces the
      // dialog's own label before any one control), not a child — so "at the boundary" also means
      // "focus hasn't left that panel root yet", not just "on the first/last real control".
      const atRoot = document.activeElement === panel.current;
      if (event.shiftKey && (document.activeElement === first || atRoot)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || atRoot)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div className="dc-modal-backdrop" onPointerDown={onClose}>
      <div
        ref={panel}
        className="dc-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ width }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="dc-modal-header">
          <h2>{title}</h2>
          <Button icon="close" variant="quiet" onClick={onClose} aria-label="Close" />
        </header>
        <div className="dc-modal-body">{children}</div>
        {footer && <footer className="dc-modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
