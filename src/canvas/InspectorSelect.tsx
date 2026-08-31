import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface InspectorSelectOption {
  value: string;
  label: string;
}

/**
 * A compact, Draft-Canvas-styled dropdown used by `EdgeInspectorPopover.tsx`'s expanded editor
 * and `ElementInspectorPopover.tsx`'s compact row — every select in either popover uses this
 * instead of a native `<select>`. A native select's closed box can be restyled with CSS, but its
 * open options popup is OS-rendered chrome no stylesheet can reach; this component owns both
 * states, so the whole popover reads as one deliberately-designed surface rather than
 * part-custom, part-browser-default.
 *
 * No portal: it lives inside the same `ViewportPortal` the popover itself renders in, so it
 * pans/zooms with the canvas for free. It does flip above/below its own trigger when needed
 * (`direction`/`preferredDirection`) — a popover placed *above* its selected element must open
 * its own dropdowns further up, not down onto the element it's editing.
 */
export function InspectorSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  preferredDirection = 'down',
  avoidRect = null,
}: {
  value: string;
  options: InspectorSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Extra class(es) on the root — e.g. `dc-inspector-select-split-first` to sit as the narrow,
   *  seamless left half of a `SplitTextEditor`-style combined field. */
  className?: string;
  /** Which side to open the menu on when there's room for it — e.g. a popover placed *above* its
   *  selected element should prefer `'up'`, so the menu opens further away from the element
   *  instead of dropping down onto it. Defaults to `'down'` (today's only behavior). Always
   *  collision-checked against the viewport (and `avoidRect`, if given) regardless of this
   *  preference — see `direction`. */
  preferredDirection?: 'up' | 'down';
  /** Screen-space vertical bounds (from `getBoundingClientRect`/`flowToScreenPosition`, not flow
   *  coordinates) of the thing this popover is editing — e.g. the selected element. Whichever
   *  direction would open toward it gets clamped as if that edge were the viewport boundary, so
   *  the menu prefers shrinking (scrollable) or flipping over actually covering it. */
  avoidRect?: { top: number; bottom: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [direction, setDirection] = useState(preferredDirection);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
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

  // Real measurement, not a guess — the menu's own rendered height and the trigger's actual
  // screen position, checked against the viewport and `avoidRect`. `getBoundingClientRect()`
  // already returns real screen pixels regardless of the canvas's own pan/zoom transform (this
  // lives inside a zoomed/panned `ViewportPortal`), so no coordinate conversion is needed here.
  // Runs before paint (layout effect), so an initial wrong guess never actually flashes on
  // screen — it resolves to the correct side (and size) in the same commit.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = buttonRef.current;
    const menu = listRef.current;
    if (!trigger || !menu) return;
    const triggerRect = trigger.getBoundingClientRect();
    const naturalHeight = menu.getBoundingClientRect().height;
    const margin = 8;
    const gap = 4; // matches the CSS gap between trigger and menu

    // Clamp each direction's available space by the viewport edge and, if `avoidRect` sits on
    // that side of the trigger, its edge too — opening toward it is exactly what this avoids.
    const topLimit =
      avoidRect && avoidRect.bottom <= triggerRect.top ? Math.max(avoidRect.bottom, margin) : margin;
    const bottomLimit =
      avoidRect && avoidRect.top >= triggerRect.bottom
        ? Math.min(avoidRect.top, window.innerHeight - margin)
        : window.innerHeight - margin;
    const space = {
      up: triggerRect.top - gap - topLimit,
      down: bottomLimit - (triggerRect.bottom + gap),
    };

    const other = preferredDirection === 'up' ? 'down' : 'up';
    // Prefer the requested side if it fully fits; else the other side if *it* fully fits; else
    // whichever has more room — the menu's own height then gets capped to whatever that is, so
    // it shrinks (scrollable) rather than covering `avoidRect` or clipping the viewport.
    const resolved =
      space[preferredDirection] >= naturalHeight
        ? preferredDirection
        : space[other] >= naturalHeight
          ? other
          : space[preferredDirection] >= space[other]
            ? preferredDirection
            : other;

    setDirection(resolved);
    setMaxHeight(Math.max(0, Math.min(220, space[resolved])));
    // `avoidRect` intentionally tracked by its own top/bottom, not the object reference — a new
    // `{top, bottom}` literal every render would otherwise rerun this on every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preferredDirection, avoidRect?.top, avoidRect?.bottom]);

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
          data-direction={direction}
          style={maxHeight !== undefined ? { maxHeight } : undefined}
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
