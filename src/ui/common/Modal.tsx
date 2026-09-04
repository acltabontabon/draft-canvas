import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Modal({ title, onClose, children, footer, width = 460 }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);

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
