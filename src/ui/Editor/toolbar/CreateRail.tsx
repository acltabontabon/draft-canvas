import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../../store/uiStore';
import { basePresetFor, DEV_PRESETS, PRESETS, SELECT_TOOLTIP, tooltipContentFor, type Preset, type PrimitiveTooltipContent } from '../../../lib/presets';
import { prefersReducedMotion } from '../../../lib/motion';
import { Button } from '../../common/Button';
import { Tooltip } from '../../common/Tooltip';
import { ShapePicker } from './ShapePicker';
import { PENCIL_TOOLTIP } from '../ink/pencilCopy';
import { PencilRail } from '../ink/PencilRail';
import { ToolGlyph } from './ToolGlyph';

/**
 * The tools with a place of their own on the rail: what nearly every diagram reaches for. The rest
 * of the vocabulary (Code, Junction, Component) is one click further, by name, in the shape picker
 * at the rail's end — and still one key away over the canvas, like every shape.
 *
 * Eleven permanent pictures asked a newcomer to learn eleven glyphs before drawing a box; the ones
 * that went are the three a diagram needs least often, not three that were hard to draw.
 */
const ON_RAIL = new Set(['text', 'note', 'boundary', 'service', 'database', 'queue', 'actor', 'sequence']);
const onRail = (preset: Preset) => ON_RAIL.has(preset.id);

const SHAPES_TOOLTIP: PrimitiveTooltipContent = {
  title: 'All shapes',
  description: 'Every shape by name, with what it is for and its key.',
  usageHint: 'Search by any name you’d use — “cache”, “user” — or by technology: “kafka”, “redis”.',
};

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
 *
 * The rail ends in the one tool that is a word: Shapes, which opens the whole vocabulary by name
 * (`ShapePicker`). A shape picked there that has no place of its own on the rail is shown in that
 * slot while it is in hand, so the rail never has a tool in hand it isn't showing.
 */
export function CreateRail() {
  const armed = useUiStore((state) => state.armed);
  const arm = useUiStore((state) => state.arm);
  const pencil = useUiStore((state) => state.pencil);
  const smart = useUiStore((state) => state.inkPrefs.smart);
  const setPencil = useUiStore((state) => state.setPencil);
  const selecting = armed === null && pencil === null;
  const railRef = useRef<HTMLDivElement>(null);
  const shapesRef = useRef<HTMLButtonElement>(null);
  const [more, setMore] = useState({ start: false, end: false });
  const [picker, setPicker] = useState<{ rect: DOMRect; trigger: HTMLElement } | null>(null);
  // In hand, but with no button of its own on the rail: the Shapes slot shows it.
  const tucked = armed && !ON_RAIL.has(armed.id) ? armed : null;
  const closePicker = () => {
    setPicker(null);
    shapesRef.current?.focus();
  };

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
  }, [armed, pencil, smart]);

  // A rail scrolled sideways would leave the picker hanging off a button that is no longer there.
  useEffect(() => {
    if (!picker) return;
    const rail = railRef.current;
    const close = () => setPicker(null);
    rail?.addEventListener('scroll', close, { passive: true });
    return () => rail?.removeEventListener('scroll', close);
  }, [picker]);

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
    <>
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
                active={selecting}
                aria-pressed={selecting}
                aria-label="Select"
                onClick={() => {
                  arm(null);
                  setPencil(null);
                }}
                {...tip}
              >
                {/* No letter: Select's key is Esc, which its tooltip shows. */}
                <ToolContent id="select" label="Select" />
              </Button>
            )}
          </Tooltip>
          {/* In hand, the Pencil unfolds into its own tools, in place of the shapes (`PencilRail`). */}
          {pencil === null && (
            <Tooltip content={PENCIL_TOOLTIP}>
              {(tip) => (
                <Button variant="ghost" className="dc-tool" aria-pressed={false} aria-label="Pencil" onClick={() => setPencil('pen')} {...tip}>
                  <ToolContent id={smart ? 'smart' : 'pencil'} label="Pencil" shortcut="P" />
                </Button>
              )}
            </Tooltip>
          )}
        </div>
        <span className="dc-rail-separator" aria-hidden="true" />
        {pencil !== null ? (
          <PencilRail tool={pencil} />
        ) : (
          <>
            <div className="dc-create-family">{PRESETS.filter(onRail).map(toolButton)}</div>
            <span className="dc-rail-separator" aria-hidden="true" />
            <div className="dc-create-family">{DEV_PRESETS.filter((preset) => onRail(preset) && preset.type !== 'sequence').map(toolButton)}</div>
            <span className="dc-rail-separator" aria-hidden="true" />
            {/* On its own: a sequence is not one more shape of an architecture but another kind of picture of it. */}
            <div className="dc-create-family">{DEV_PRESETS.filter((preset) => onRail(preset) && preset.type === 'sequence').map(toolButton)}</div>
            <span className="dc-rail-separator" aria-hidden="true" />
            <div className="dc-create-family">
              <Tooltip content={tucked ? tooltipContentFor(tucked) : SHAPES_TOOLTIP}>
                {(tip) => (
                  <Button
                    ref={shapesRef}
                    variant="ghost"
                    className="dc-tool dc-tool-shapes"
                    active={tucked !== null}
                    aria-pressed={tucked ? true : undefined}
                    aria-haspopup="dialog"
                    aria-expanded={picker !== null}
                    aria-label={tucked ? `${tucked.label} — all shapes` : 'All shapes'}
                    data-open={picker !== null || undefined}
                    {...tip}
                    onClick={(event) => {
                      const trigger = event.currentTarget;
                      setPicker((open) => (open ? null : { rect: trigger.getBoundingClientRect(), trigger }));
                    }}
                  >
                    {tucked ? (
                      // A shape picked as a technology draws as the shape it is, under the technology's name.
                      <ToolContent id={basePresetFor(tucked).id} label={tucked.label} />
                    ) : (
                      <span className="dc-tool-shapes-word">Shapes</span>
                    )}
                    <svg className="dc-tool-caret" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true" focusable="false">
                      <path d="M1.5 3 4 5.5 6.5 3" />
                    </svg>
                  </Button>
                )}
              </Tooltip>
            </div>
          </>
        )}
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
      {picker && (
        <ShapePicker
          anchorRect={picker.rect}
          trigger={picker.trigger}
          armedId={armed?.id ?? null}
          onPick={(preset) => {
            closePicker();
            arm(preset);
          }}
          onDismiss={closePicker}
        />
      )}
    </>
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
