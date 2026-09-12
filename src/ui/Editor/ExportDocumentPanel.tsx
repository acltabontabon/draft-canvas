import { SegmentedControl } from '../common/SegmentedControl';
import type { DocumentFormat } from './exportTypes';

const DESCRIPTIONS: Record<DocumentFormat, string> = {
  editable: 'Plain, diffable JSON. Reopen it in Draft Canvas and keep editing.',
  secure: "Locked with a passphrase you choose. Lose it, and the file can't be opened.",
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
      <p className="dc-export-panel-description">{DESCRIPTIONS[format]}</p>
    </div>
  );
}
