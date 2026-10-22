import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../../store/uiStore';
import { DEV_PRESETS, PRESETS, SELECT_TOOLTIP, tooltipContentFor, type Preset } from '../../../canvas/presets';
import { prefersReducedMotion } from '../../../lib/motion';
import { Button } from '../../common/Button';
import { Tooltip } from '../../common/Tooltip';
import { ToolGlyph } from './ToolGlyph';

/**
 * What you can put on the canvas — the toolbar's centre of gravity, since drawing architecture is
 * the whole point of the app.
 *
 * One recessed rail holding exactly one active segment: the tool currently in your hand. The
 * trough is the `SegmentedControl` idiom (`--dc-canvas` in a hairline border), which the codebase
 * already uses wherever one option of several is chosen — so this reads as native rather than as
 * a new kind of container invented for the toolbar.
 *
 * Pictures that are the shapes themselves, in miniature (`ToolGlyph`): a Data Store is a small
 * cylinder, a Queue a small tube — so there is no private glyph vocabulary to learn, which is why
 * this bar once used words alone. The words are still there where they matter: the tool in your hand
 * shows its name beside its picture, every tool names itself on hover (with its key and what it is
 * for), and each carries its letter, small: press it over the canvas and that shape lands at the
 * pointer, so the keyboard is learnable at a glance.
 *
 * It is drawn the way Draft Canvas draws: the tools sit on a strip of the canvas's own dotted
 * ground, idle ones in graphite; the one in hand turns to the product's teal ink, draws itself in, and
 * writes its name in the mono face a drawing's annotations use. The three families — interaction,
 * annotation, architecture — are separated by quiet hairlines, so the group boundaries cannot be
 * mistaken for another drawing tool.
 */
export function CreateRail() {
  const armed = useUiStore((state) => state.armed);
  const arm = useUiStore((state) => state.arm);
  const railRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });

  // On a window too narrow for every tool the rail scrolls, with its scrollbar hidden — so each end
  // that has more tools past it fades out, and a plain mouse wheel scrolls it sideways.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const update = () => {
      const hidden = rail.scrollWidth - rail.clientWidth;
      const start = hidden > 1 && rail.scrollLeft > 1;
      const end = hidden > 1 && rail.scrollLeft < hidden - 1;
      rail.dataset.moreStart = String(start);
      rail.dataset.moreEnd = String(end);
      setMore((current) => (current.start === start && current.end === end ? current : { start, end }));
    };
    update();
    let frame: number | undefined;
    const onResize = () => {
      // Overflow chevrons change the rail's intrinsic width. Adding them inside its resize
      // notification caused another layout cycle while narrow title/header tracks were settling.
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    // Absent in a test DOM; the rail's size then never changes anyway.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    observer?.observe(rail);
    rail.addEventListener('scroll', update, { passive: true });
    return () => {
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      rail.removeEventListener('scroll', update);
    };
  }, []);

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const rail = event.currentTarget;
    if (rail.scrollWidth <= rail.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    rail.scrollLeft += event.deltaY;
  };

  const segments = () => [...(railRef.current?.querySelectorAll<HTMLButtonElement>('button:not(.dc-create-rail-more)') ?? [])];

  // A fade says there is more, but a mouse without a sideways wheel — or anyone who doesn't think to
  // scroll a toolbar — had no way to reach "Junction" on a narrow window. A click on the chevron
  // pages the rail. Out of the tab order: the keyboard moves along the rail with the arrow keys.
  const page = (direction: 1 | -1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * rail.clientWidth * 0.8, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  // One tab stop for the whole rail, per the ARIA toolbar pattern: eleven separate stops made
  // reaching the canvas by keyboard a chore. The stop lives on the tool you actually have in
  // hand, so tabbing in and pressing an arrow starts from where you already are.
  useEffect(() => {
    const items = segments();
    const active = items.findIndex((button) => button.getAttribute('aria-pressed') === 'true');
    const home = active === -1 ? 0 : active;
    for (const [index, button] of items.entries()) button.tabIndex = index === home ? 0 : -1;
  }, [armed]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = segments();
    const from = items.indexOf(document.activeElement as HTMLButtonElement);
    if (from === -1) return;
    // Both are load-bearing. `EditorScreen`'s window key handler nudges the selected element on
    // arrow keys and only bails on editable targets — a focused button is not one — so without
    // `stopPropagation` here, arrowing along the rail would quietly move the user's diagram.
    // Escape is deliberately not intercepted: `Tooltip` documents that contract.
    event.preventDefault();
    event.stopPropagation();
    const to =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowLeft'
            ? Math.max(0, from - 1)
            : Math.min(items.length - 1, from + 1);
    for (const [index, button] of items.entries()) button.tabIndex = index === to ? 0 : -1;
    items[to]?.focus();
  };

  const toolButton = (preset: Preset) => (
    <Tooltip key={preset.id} content={tooltipContentFor(preset)}>
      {(tip) => (
        <Button
          variant="ghost"
          className="dc-tool"
          active={armed?.id === preset.id}
          aria-pressed={armed?.id === preset.id}
          aria-label={preset.label}
          onClick={() => arm(armed?.id === preset.id ? null : preset)}
          {...tip}
        >
          <ToolContent id={preset.id} label={preset.label} shortcut={preset.shortcut} />
        </Button>
      )}
    </Tooltip>
  );

  return (
    <div
      ref={railRef}
      className="dc-create-rail"
      role="toolbar"
      aria-label="Create"
      onKeyDown={onKeyDown}
      onWheel={onWheel}
    >
      <div className="dc-create-family">
        <Tooltip content={SELECT_TOOLTIP}>
          {(tip) => (
            <Button
              variant="ghost"
              className="dc-tool"
              active={armed === null}
              aria-pressed={armed === null}
              aria-label="Select"
              onClick={() => arm(null)}
              {...tip}
            >
              {/* No letter: Select's key is Esc, which its tooltip shows. */}
              <ToolContent id="select" label="Select" />
            </Button>
          )}
        </Tooltip>
      </div>
      <span className="dc-rail-separator" aria-hidden="true" />
      <div className="dc-create-family">{PRESETS.map(toolButton)}</div>
      <span className="dc-rail-separator" aria-hidden="true" />
      <div className="dc-create-family">{DEV_PRESETS.map(toolButton)}</div>
      {more.start && (
        <button type="button" className="dc-create-rail-more" data-side="start" tabIndex={-1} aria-label="Show earlier tools" onClick={() => page(-1)}>
          ‹
        </button>
      )}
      {more.end && (
        <button type="button" className="dc-create-rail-more" data-side="end" tabIndex={-1} aria-label="Show more tools" onClick={() => page(1)}>
          ›
        </button>
      )}
    </div>
  );
}

/**
 * A tool's face: its picture, its name (seen only while it is the tool in hand — the button's
 * accessible name is the name either way), and its key, small, in the corner.
 */
function ToolContent({ id, label, shortcut }: { id: string; label: string; shortcut?: string }) {
  return (
    <>
      <ToolGlyph id={id} />
      <span className="dc-tool-name">{label}</span>
      {shortcut && (
        <span className="dc-tool-key" aria-hidden="true">
          {shortcut}
        </span>
      )}
    </>
  );
}
