import { useEffect, useRef, type MouseEvent } from 'react';
import { useUiStore } from '../../store/uiStore';
import { Button } from './Button';

export function Toasts() {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismiss);
  const pauseToasts = useUiStore((state) => state.pauseToasts);
  const resumeToasts = useUiStore((state) => state.resumeToasts);
  const root = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);

  // Removing the toast that held focus fires no blur, so the pause it started would outlive it and
  // every remaining toast would stay up for good.
  useEffect(() => {
    if (hovered.current || !root.current || root.current.contains(document.activeElement)) return;
    resumeToasts();
  }, [toasts, resumeToasts]);

  /** Dismissing from the keyboard hands focus to a neighbouring toast rather than dropping it on the page. */
  const dismissFrom = (event: MouseEvent<HTMLElement>, id: number) => {
    const toast = event.currentTarget.closest('.dc-toast');
    const neighbour = (toast?.nextElementSibling ?? toast?.previousElementSibling)?.querySelector<HTMLElement>(
      '.dc-toast-dismiss',
    );
    const hadFocus = toast?.contains(document.activeElement) ?? false;
    dismiss(id);
    if (hadFocus) neighbour?.focus();
  };

  // Always mounted, even empty: a live region that appears together with its first message is
  // often not announced at all. An error interrupts (`alert`); anything else waits its turn.
  return (
    <div
      ref={root}
      className="dc-toasts"
      aria-live="polite"
      onPointerEnter={() => {
        hovered.current = true;
        pauseToasts();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        resumeToasts();
      }}
      onFocus={pauseToasts}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resumeToasts();
      }}
    >
      {toasts.map((toast) => (
        <div key={toast.id} className="dc-toast" data-tone={toast.tone} role={toast.tone === 'error' ? 'alert' : undefined}>
          <span className="dc-toast-message">{toast.message}</span>
          {toast.action && (
            <Button
              variant="quiet"
              className="dc-toast-action"
              onClick={(event) => {
                toast.action!.run();
                dismissFrom(event, toast.id);
              }}
            >
              {toast.action.label}
            </Button>
          )}
          <Button
            icon="close"
            variant="quiet"
            className="dc-toast-dismiss"
            onClick={(event) => dismissFrom(event, toast.id)}
            aria-label="Dismiss"
          />
        </div>
      ))}
    </div>
  );
}
