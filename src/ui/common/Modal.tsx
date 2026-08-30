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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    panel.current?.focus();
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
