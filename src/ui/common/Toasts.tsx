import { useUiStore } from '../../store/uiStore';
import { Button } from './Button';

export function Toasts() {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismiss);
  const pauseToasts = useUiStore((state) => state.pauseToasts);
  const resumeToasts = useUiStore((state) => state.resumeToasts);

  // Always mounted, even empty: a live region that appears together with its first message is
  // often not announced at all. An error interrupts (`alert`); anything else waits its turn.
  return (
    <div
      className="dc-toasts"
      aria-live="polite"
      onPointerEnter={pauseToasts}
      onPointerLeave={resumeToasts}
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
              onClick={() => {
                toast.action!.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </Button>
          )}
          <Button icon="close" variant="quiet" onClick={() => dismiss(toast.id)} aria-label="Dismiss" />
        </div>
      ))}
    </div>
  );
}
