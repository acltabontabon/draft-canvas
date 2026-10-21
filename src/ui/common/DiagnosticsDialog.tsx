import { useUiStore } from '../../store/uiStore';
import { DiagnosticReport } from './DiagnosticReport';
// The lazy `Modal`: this dialog is mounted by `App` on every screen, so a direct import would put
// React Aria's dialog code in the first chunk for a report that is rarely opened.
import { Modal } from './LazyModal';

/** Web troubleshooting, available from Home and the editor without opening About. */
export function DiagnosticsDialog() {
  const open = useUiStore((state) => state.diagnosticsOpen);
  const setOpen = useUiStore((state) => state.setDiagnosticsOpen);
  return open ? (
    <Modal title="Diagnostic report" width={600} onClose={() => setOpen(false)}>
      <DiagnosticReport />
    </Modal>
  ) : null;
}
