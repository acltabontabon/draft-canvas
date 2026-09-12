import { useUiStore } from '../../store/uiStore';
import { Button } from './Button';

export function Toasts() {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismiss);

  // Always mounted, even empty: a live region that appears together with its first message is
  // often not announced at all. An error interrupts (`alert`); anything else waits its turn.
  return (
    <div className="dc-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="dc-toast" data-tone={toast.tone} role={toast.tone === 'error' ? 'alert' : undefined}>
          <span>{toast.message}</span>
          <Button icon="close" variant="quiet" onClick={() => dismiss(toast.id)} aria-label="Dismiss" />
        </div>
      ))}
    </div>
  );
}
