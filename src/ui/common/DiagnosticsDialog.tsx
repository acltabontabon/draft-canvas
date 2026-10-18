import { useUiStore } from '../../store/uiStore';
import { DiagnosticReport } from './DiagnosticReport';
import { Modal } from './Modal';

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
