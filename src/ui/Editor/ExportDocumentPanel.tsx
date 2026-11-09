import { SegmentedControl } from '../common/SegmentedControl';
import type { DocumentFormat } from '../../export/exportTypes';

/** One short line under the choice: what you can do with the file you'll get. */
const HINTS: Record<DocumentFormat, string> = {
  editable: 'Plain JSON that opens again in Draft Canvas.',
  secure: 'Needs its passphrase, which can’t be recovered.',
};

export function ExportDocumentPanel({
  format,
  onChange,
}: {
  format: DocumentFormat;
  onChange: (format: DocumentFormat) => void;
}) {
  return (
    <div className="dc-export-panel">
      <div className="dc-export-form">
        <span className="dc-export-label" aria-hidden="true">Format</span>
        <SegmentedControl
          name="document-format"
          legend="Document type"
          value={format}
          onChange={onChange}
          options={[
            { value: 'editable', label: 'Editable' },
            { value: 'secure', label: 'Encrypted' },
          ]}
        />
        <span aria-hidden="true" />
        <p className="dc-export-hint">{HINTS[format]}</p>
      </div>
    </div>
  );
}
