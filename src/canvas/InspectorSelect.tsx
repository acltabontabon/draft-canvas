import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { clamp } from '../lib/math';

/** The least a menu is allowed to shrink to: about three options, so it is still a list. */
const MIN_MENU_HEIGHT = 96;
const RICH_MENU_MAX_HEIGHT = 380;

export interface InspectorSelectOption {
  value: string;
  label: string;
  /** A small preview rendered before the label — e.g. a kind's shape preview. Only meaningful
   *  alongside `layout: 'grid'` or `'rich'`; ignored by the default list layout. */
  icon?: ReactNode;
  /** One short line saying what choosing this means — shown under the label by `layout: 'rich'`,
   *  and as the option's tooltip everywhere else. */
  description?: string;
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
  getAvoidRect,
  layout = 'list',
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
  /** The same bounds, read at the moment the menu opens — for a thing that can move on screen without
   *  this component re-rendering (a canvas element under a pan). Takes precedence over `avoidRect`. */
  getAvoidRect?: () => { top: number; bottom: number } | null;
  /** `'grid'` switches the menu to a compact 2-column layout with room for each option's `icon` —
   *  used only by the Data Store kind picker, whose seven options are worth previewing visually.
   *  Defaults to `'list'`, today's exact behaviour, so every other picker is untouched. `'rich'` is
   *  one column of preview + name + a line of `description` — for a picker whose options differ
   *  in *purpose* more than in look (Boundary), where the name alone doesn't say enough. */
  layout?: 'list' | 'grid' | 'rich';
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [direction, setDirection] = useState(preferredDirection);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const [hAlign, setHAlign] = useState<'start' | 'end'>('start');
  const [menuMaxWidth, setMenuMaxWidth] = useState<number | undefined>(undefined);
  // Bumped when something that changes how much room the menu has happens while it is open — see
  // the effect below — so the measurement is redone rather than left describing a screen that is gone.
  const [measureTick, setMeasureTick] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const optionIdPrefix = useId();

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

  // The menu is placed from what was measured when it opened, and a menu that stays open while the
  // window is resized, or the canvas is panned or zoomed with the wheel underneath it, is being
  // judged against a screen that no longer exists: what fitted below the trigger a moment ago may
  // now run off the bottom of the pane with its last options unreachable. Both re-measure, once per
  // frame at most.
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const remeasure = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setMeasureTick((tick) => tick + 1);
      });
    };
    window.addEventListener('resize', remeasure);
    window.addEventListener('wheel', remeasure, { passive: true });
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('wheel', remeasure);
      if (frame) window.cancelAnimationFrame(frame);
    };
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
    const menuRect = menu.getBoundingClientRect();
    // `scrollHeight` as well as the box: on a re-measure the menu already wears the cap it was given
    // last time, and its box would report *that* rather than what it wants — so a menu squeezed by a
    // window that has since grown back would never find out it could have its full height again.
    const naturalHeight = Math.max(menuRect.height, menu.scrollHeight);
    const naturalWidth = menuRect.width;
    const margin = 8;
    const gap = 4; // matches the CSS gap between trigger and menu
    const avoid = getAvoidRect ? getAvoidRect() : avoidRect;

    // The menu is measured against the canvas pane's own rect, not the browser viewport: this
    // select lives inside React Flow's `overflow: hidden` root, which is usually shorter than the
    // window (the toolbar and status bar sit above/below it), so a popover near the top or bottom
    // of the *canvas* would otherwise be told it has room it doesn't — the menu would open past
    // the pane's own edge and get silently clipped, hiding whichever options landed there. Falls
    // back to the window when there's no such ancestor (e.g. this component rendered standalone).
    const flowRoot = trigger.closest('.react-flow');
    const flowRect = flowRoot?.getBoundingClientRect();
    const viewTop = flowRect?.top ?? 0;
    const viewBottom = flowRect?.bottom ?? window.innerHeight;
    const viewLeft = flowRect?.left ?? 0;
    const viewRight = flowRect?.right ?? window.innerWidth;

    // Clamp each direction's available space by the canvas edge and, if `avoidRect` sits on
    // that side of the trigger, its edge too — opening toward it is exactly what this avoids.
    const spaceWithin = (respectAvoid: boolean) => {
      const topLimit =
        respectAvoid && avoid && avoid.bottom <= triggerRect.top
          ? Math.max(avoid.bottom, viewTop + margin)
          : viewTop + margin;
      const bottomLimit =
        respectAvoid && avoid && avoid.top >= triggerRect.bottom
          ? Math.min(avoid.top, viewBottom - margin)
          : viewBottom - margin;
      return {
        up: triggerRect.top - gap - topLimit,
        down: bottomLimit - (triggerRect.bottom + gap),
      };
    };

    const other = preferredDirection === 'up' ? 'down' : 'up';
    // Prefer the requested side if it fully fits; else the other side if *it* fully fits; else
    // whichever has more room.
    const pick = (space: Record<'up' | 'down', number>) =>
      space[preferredDirection] >= naturalHeight
        ? preferredDirection
        : space[other] >= naturalHeight
          ? other
          : space[preferredDirection] >= space[other]
            ? preferredDirection
            : other;

    let space = spaceWithin(true);
    let resolved = pick(space);
    // `avoidRect` is a preference, not a boundary. With the popover near the canvas edge, the
    // strip left between that edge and the shape being edited can be shorter than the menu — and
    // capping to it hides options behind a scrollbar, which is a worse failure than briefly
    // covering the shape: the whole point of the menu is to show what you can pick. So when
    // neither direction can fit the menu while honouring the rect, this asks again ignoring it,
    // and takes that only if it genuinely has more room.
    if (space[resolved] < naturalHeight && avoid) {
      const free = spaceWithin(false);
      const freeResolved = pick(free);
      if (free[freeResolved] > space[resolved]) {
        space = free;
        resolved = freeResolved;
      }
    }

    setDirection(resolved);
    // Never a sliver: with next to no room either way, a menu a few pixels tall is worse than one
    // that reaches past the pane's edge, which is at least a list somebody can scroll.
    // A rich list's rows are two lines tall; it gets the room to show its whole set unscrolled.
    setMaxHeight(clamp(space[resolved], MIN_MENU_HEIGHT, layout === 'rich' ? RICH_MENU_MAX_HEIGHT : 220));

    // Horizontal: the menu (now free to grow via CSS `width: max-content`) is measured at its
    // natural, unclamped width — the widest option's real width, not the trigger's. It stays
    // left-aligned with the trigger when that fits; otherwise it flips to right-align (still
    // anchored to the trigger, just growing the other way), and only clamps to a `maxWidth` when
    // neither side has room, so genuinely narrow viewports still degrade to the existing
    // ellipsis rather than overflowing the screen.
    const spaceRight = viewRight - margin - triggerRect.left;
    const spaceLeft = triggerRect.right - viewLeft - margin;
    let align: 'start' | 'end' = 'start';
    let clampedWidth: number | undefined;
    if (naturalWidth > spaceRight) {
      if (naturalWidth <= spaceLeft) {
        align = 'end';
      } else {
        align = spaceLeft >= spaceRight ? 'end' : 'start';
        clampedWidth = Math.max(spaceLeft, spaceRight);
      }
    }
    setHAlign(align);
    setMenuMaxWidth(clampedWidth);
    // `avoidRect` intentionally tracked by its own top/bottom, not the object reference — a new
    // `{top, bottom}` literal every render would otherwise rerun this on every render. `options`
    // is tracked by a cheap label signature (not the array reference) so a caller that swaps
    // options while the menu stays open and mounted (e.g. switching selection between shape
    // types) re-measures instead of keeping a stale width from the previous option set.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, measureTick, preferredDirection, avoidRect?.top, avoidRect?.bottom, getAvoidRect, layout, options.map((o) => o.label).join('\u0000')]);

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
        // The visible value is part of the name — an `aria-label` alone would replace it, and a
        // screen reader would announce "Service type" without ever saying which one.
        aria-label={current ? `${ariaLabel}: ${current.label}` : ariaLabel}
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
          data-h-align={hAlign}
          data-layout={layout}
          style={{
            ...(maxHeight !== undefined ? { maxHeight } : null),
            ...(menuMaxWidth !== undefined ? { maxWidth: menuMaxWidth } : null),
          }}
          role="listbox"
          aria-label={ariaLabel}
          // Focus stays on the list while arrow keys move the highlight; this is what tells
          // assistive tech which option that is.
          aria-activedescendant={`${optionIdPrefix}-${highlighted}`}
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
              id={`${optionIdPrefix}-${index}`}
              role="option"
              aria-selected={index === selectedIndex}
              className="dc-inspector-select-option"
              data-highlighted={index === highlighted ? 'true' : undefined}
              title={layout === 'rich' ? undefined : option.description}
              onPointerEnter={() => setHighlighted(index)}
              onClick={() => commit(index)}
            >
              {option.icon && <span className="dc-inspector-select-option-icon">{option.icon}</span>}
              {layout === 'rich' ? (
                <span className="dc-inspector-select-option-text">
                  <span className="dc-inspector-select-option-label">{option.label}</span>
                  {option.description && (
                    <span className="dc-inspector-select-option-description">{option.description}</span>
                  )}
                </span>
              ) : (
                <span className="dc-inspector-select-option-label">{option.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
