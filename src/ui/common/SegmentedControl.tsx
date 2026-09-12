/**
 * A small labeled group of mutually-exclusive options rendered as pills. Built on native
 * `<input type="radio">` (visually hidden via `.dc-sr-only`, not `display:none`) rather than
 * clickable `<div>`s, so arrow-key navigation and correct `radiogroup` semantics come for free
 * from the browser instead of custom key handling.
 */
interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  name: string;
  legend: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  disabled,
}: SegmentedControlProps<T>) {
  return (
    <div className="dc-segmented" role="radiogroup" aria-label={legend} data-disabled={disabled ? 'true' : undefined}>
      {options.map((option) => (
        <label key={option.value} className="dc-segmented-option" data-value={option.value}>
          <input
            type="radio"
            name={name}
            className="dc-sr-only"
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
            aria-label={option.label}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
