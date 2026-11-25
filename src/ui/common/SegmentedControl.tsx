import { Icon } from './Icon';

/**
 * A small labeled group of mutually-exclusive options rendered as pills. Built on native
 * `<input type="radio">` (visually hidden via `.dc-sr-only`, not `display:none`) rather than
 * clickable `<div>`s, so arrow-key navigation and correct `radiogroup` semantics come for free
 * from the browser instead of custom key handling.
 */
interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** The full name, when `label` is a shortened one to fit beside the others; it should contain
   *  `label`, so what a voice-control user reads off the pill still names it. */
  name?: string;
  /** A state the option is in, apart from being chosen: a small mark on the pill, and said after its
   *  name. The agent picker marks the agents that are already set up. */
  status?: { tone: 'on' | 'warn'; label: string };
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
        <label key={option.value} className="dc-segmented-option" data-value={option.value} data-status={option.status?.tone}>
          <input
            type="radio"
            name={name}
            className="dc-sr-only"
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
            aria-label={option.status ? `${option.name ?? option.label}, ${option.status.label}` : (option.name ?? option.label)}
          />
          {option.label}
          {option.status && (
            <span className="dc-segmented-mark" aria-hidden="true">
              {option.status.tone === 'on' && <Icon name="check" size={11} />}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
