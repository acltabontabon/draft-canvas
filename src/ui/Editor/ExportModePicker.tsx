import { Icon, type IconName } from '../common/Icon';
import type { ExportMode } from '../../export/exportTypes';

// What people come here to do, most common first — then the formats that only mean something to
// someone who already knows they want one. The keyboard walks them in this order.
const EVERYDAY: ExportMode[] = ['share', 'document', 'image', 'docs'];
const ADVANCED: ExportMode[] = ['sequence'];

/**
 * Named for the intention, not for the thing the code calls it. "Document", "Docs" and "Source" were
 * three words for distinctions only the implementation makes, and a newcomer had to open each tab
 * to find out which one saves the file they can reopen. The line under each name says what you end
 * up holding; the mode ids (and `data-mode`) are unchanged.
 */
const MODE_META: Record<ExportMode, { label: string; hint: string; icon: IconName }> = {
  share: { label: 'Share a link', hint: 'Read-only, in any browser', icon: 'link' },
  document: { label: 'Save an editable file', hint: 'Reopen, back up or send', icon: 'file' },
  image: { label: 'Save an image', hint: 'PNG or SVG, or copy it', icon: 'image' },
  docs: { label: 'Use in a README', hint: 'A picture plus its Markdown', icon: 'docs' },
  sequence: { label: 'Other formats', hint: 'Mermaid, PlantUML, draw.io…', icon: 'code' },
};

/**
 * What do you want to do — a short list read top to bottom, each choice with the one line that
 * tells it from its neighbours, and the specialised formats set apart underneath. Every choice
 * stays selectable even when its export is currently empty (no Flow yet, for a sequence diagram):
 * hiding it would make the capability undiscoverable, so the unavailable case is explained inside
 * its panel instead (see `ExportSequencePanel`).
 */
export function ExportModePicker({ mode, onChange }: { mode: ExportMode; onChange: (mode: ExportMode) => void }) {
  const choice = (m: ExportMode) => {
    const meta = MODE_META[m];
    return (
      <label key={m} className="dc-export-mode" data-mode={m}>
        <input
          type="radio"
          name="export-mode"
          className="dc-sr-only"
          checked={mode === m}
          onChange={() => onChange(m)}
          aria-label={`${meta.label} — ${meta.hint}`}
        />
        <Icon name={meta.icon} size={15} />
        <span className="dc-export-mode-text" aria-hidden="true">
          <span className="dc-export-mode-label">{meta.label}</span>
          <span className="dc-export-mode-hint">{meta.hint}</span>
        </span>
      </label>
    );
  };
  return (
    <div className="dc-export-modes" role="radiogroup" aria-label="What to export">
      {EVERYDAY.map(choice)}
      <span className="dc-export-modes-rule" aria-hidden="true" />
      {ADVANCED.map(choice)}
    </div>
  );
}
