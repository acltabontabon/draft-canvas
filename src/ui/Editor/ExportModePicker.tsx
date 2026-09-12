import { Icon, type IconName } from '../common/Icon';
import type { ExportMode } from './exportTypes';

const MODE_ORDER: ExportMode[] = ['document', 'image', 'animated', 'sequence'];

// The label is the only thing rendered — `hint` exists purely to give screen-reader users the
// same "what formats live here" context a sighted user gets from the panel a click away, without
// printing it as a second, visually-duplicated subtitle under every card.
const MODE_META: Record<ExportMode, { label: string; hint: string; icon: IconName }> = {
  document: { label: 'Document', hint: 'editable or encrypted', icon: 'file' },
  image: { label: 'Image', hint: 'PNG or SVG', icon: 'image' },
  animated: { label: 'Animated', hint: 'GIF', icon: 'play' },
  sequence: { label: 'Source', hint: 'Mermaid or PlantUML sequence diagram', icon: 'code' },
};

/**
 * What am I exporting — compact navigation with enough personality to stay recognizable at a
 * glance, not a row of feature cards. Every card stays selectable even when its export is
 * currently empty (no Flow yet, for Animated/Source): hiding a whole mode would make the
 * capability undiscoverable, so the unavailable case is explained inside its panel instead (see
 * `ExportAnimatedPanel`/`ExportSequencePanel`).
 */
export function ExportModePicker({ mode, onChange }: { mode: ExportMode; onChange: (mode: ExportMode) => void }) {
  return (
    <div className="dc-export-modes" role="radiogroup" aria-label="Export type">
      {MODE_ORDER.map((m) => {
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
            <Icon name={meta.icon} size={14} />
            {meta.label}
          </label>
        );
      })}
    </div>
  );
}
