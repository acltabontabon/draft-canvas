import { useEffect, useRef, useState } from 'react';

export interface InspectorSelectOption {
  value: string;
  label: string;
}

/**
 * A compact, Draft-Canvas-styled dropdown for `EdgeInspectorPopover.tsx`'s expanded editor —
 * every select in that popover uses this instead of a native `<select>`. A native select's
 * closed box can be restyled with CSS, but its open options popup is OS-rendered chrome no
 * stylesheet can reach; this component owns both states, so the whole popover reads as one
 * deliberately-designed surface rather than part-custom, part-browser-default.
 *
 * Deliberately small: no portal, no viewport-flip logic. It lives inside the same
 * `ViewportPortal` the popover itself renders in, so it pans/zooms with the canvas for free,
 * and every options list in this popover is short enough (2-6 items) that a fixed
 * anchored-below menu never needs to reposition itself.
 */
export function InspectorSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: string;
  options: InspectorSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Extra class(es) on the root — e.g. `dc-inspector-select-split-first` to sit as the narrow,
   *  seamless left half of a `SplitTextEditor`-style combined field. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options[selectedIndex];

  // Click-outside closes without committing — same pattern the popover's own sub-panels use
  // (`EdgeInspectorPopover.tsx`'s click-away effect) — registered one tick late so the very
  // click that opened this menu doesn't immediately close it again.
  useEffect(() => {
    if (!open) return;
    setHighlighted(selectedIndex);
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
    // selectedIndex intentionally excluded — only the initial highlight when opening should
    // reset it; arrow-key navigation owns `highlighted` afterward until the menu closes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const commit = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className={className ? `dc-inspector-select ${className}` : 'dc-inspector-select'} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="dc-inspector-control dc-inspector-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dc-inspector-select-value">{current?.label ?? ''}</span>
        <span className="dc-inspector-select-chevron" aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={listRef}
          className="dc-inspector-select-menu"
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          onKeyDown={(event) => {
            event.stopPropagation();
            switch (event.key) {
              case 'ArrowDown':
                event.preventDefault();
                setHighlighted((i) => (i + 1) % options.length);
                break;
              case 'ArrowUp':
                event.preventDefault();
                setHighlighted((i) => (i - 1 + options.length) % options.length);
                break;
              case 'Enter':
              case ' ':
                event.preventDefault();
                commit(highlighted);
                break;
              case 'Escape':
                event.preventDefault();
                setOpen(false);
                buttonRef.current?.focus();
                break;
              case 'Tab':
                setOpen(false);
                break;
              default:
                break;
            }
          }}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={index === selectedIndex}
              className="dc-inspector-select-option"
              data-highlighted={index === highlighted ? 'true' : undefined}
              onPointerEnter={() => setHighlighted(index)}
              onClick={() => commit(index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
