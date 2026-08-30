import { useUiStore } from '../../store/uiStore';
import { Button } from './Button';

export function Toasts() {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="dc-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="dc-toast" data-tone={toast.tone}>
          <span>{toast.message}</span>
          <Button icon="close" variant="quiet" onClick={() => dismiss(toast.id)} aria-label="Dismiss" />
        </div>
      ))}
    </div>
  );
}
