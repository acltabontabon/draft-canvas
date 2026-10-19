import { Suspense, useCallback, type ComponentProps } from 'react';
import { logDiagnostic } from '../../lib/diagnostics';
import { loadFailureNotice } from '../../lib/staleChunk';
import { useUiStore } from '../../store/uiStore';
import type { Modal as ModalComponent } from './Modal';
import { PanelBoundary } from './PanelBoundary';
import { retryableLazy } from './retryableLazy';

const loaded = retryableLazy(() => import('./Modal').then((module) => ({ default: module.Modal })));

/**
 * `Modal` for a screen that only sometimes opens one — the Library's rename, delete and passphrase
 * prompts. The dialog (React Aria's focus scope, scroll lock and outside-hiding, ~64 KB) arrives with
 * the first one instead of with the Library's first paint. Callers render it only while it is open, so
 * nothing shows while it loads. A chunk that cannot be fetched (offline, or replaced by a deploy under
 * an old tab) closes the dialog with a message rather than taking the Library down, and the next open
 * tries a fresh import.
 */
export function Modal(props: ComponentProps<typeof ModalComponent>) {
  const { onClose } = props;
  const failed = useCallback(
    (error: Error, componentStack: string) => {
      logDiagnostic(error, { operation: 'library-dialog' }, componentStack);
      loaded.reset();
      onClose();
      const notice = loadFailureNotice(error, 'That couldn’t open. Check your connection and try again.');
      useUiStore.getState().notify(notice.message, 'error', notice.action);
    },
    [onClose],
  );
  return (
    <PanelBoundary onError={failed}>
      <Suspense fallback={null}>
        <loaded.Component {...props} />
      </Suspense>
    </PanelBoundary>
  );
}
