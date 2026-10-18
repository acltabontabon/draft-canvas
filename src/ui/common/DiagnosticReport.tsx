import { useState } from 'react';
import { diagnosticReport } from '../../lib/diagnostics';
import { downloadText } from '../../export/download';
import { useUiStore } from '../../store/uiStore';

/** Snapshot on opening: the downloaded bytes must match what the person reviewed. */
export function DiagnosticReport() {
  const [report] = useState(diagnosticReport);
  const notify = useUiStore((state) => state.notify);

  return (
    <div className="dc-diagnostics">
      <p className="dc-muted">
        A local report of recent failures in this session. It excludes diagram content, file paths,
        identifiers and error messages. Review it before sharing.
      </p>
      <textarea aria-label="Diagnostic report contents" readOnly value={report} rows={12} className="dc-diagnostics-preview" />
      <button
        type="button"
        className="dc-button dc-button-solid dc-diagnostics-download"
        onClick={() => {
          void downloadText(report, 'draft-canvas-diagnostics.json', 'application/json').catch((error: unknown) => {
            if ((error instanceof Error || error instanceof DOMException) && error.name === 'AbortError') return;
            notify('The diagnostic report could not be saved.', 'error');
          });
        }}
      >
        Download report
      </button>
    </div>
  );
}
