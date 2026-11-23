import type { ReactNode } from 'react';

/**
 * A choice shown as what it does: each option is a small drawing with its name beneath, so
 * "bold" is a heavy line and "round" a round corner before either is read.
 *
 * The same native radios as `SegmentedControl`, so the keyboard and a screen reader get a
 * `radiogroup` with nothing written for them.
 */
export interface LookOption<T extends string> {
  value: T;
  label: string;
  /** The full name, when `label` alone does not say what it is a choice of. */
  name?: string;
  art: ReactNode;
}

export function LookTiles<T extends string>({ name, legend, value, options, onChange }: { name: string; legend: string; value: T; options: LookOption<T>[]; onChange: (value: T) => void }) {
  return (
    <div className="dc-look-tiles" role="radiogroup" aria-label={legend}>
      {options.map((option) => (
        <label key={option.value} className="dc-look-tile" data-value={option.value}>
          <input type="radio" name={name} className="dc-sr-only" checked={value === option.value} onChange={() => onChange(option.value)} aria-label={option.name ?? option.label} />
          <span className="dc-look-tile-art" aria-hidden="true">
            {option.art}
          </span>
          <span className="dc-look-tile-label">{option.label}</span>
        </label>
      ))}
    </div>
  );
}
