import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  anchorsForRect,
  placementTransform,
  resolvePlacement,
  type PlacementPoint,
} from '../../../canvas/popoverPlacement';
import { DEV_PRESETS, PRESETS, searchPresets, type Preset } from '../../../lib/presets';
import { isEditableTarget } from '../../../lib/isEditableTarget';
import { MOD_SYMBOL } from '../../../lib/platform';
import { useTechnologyIcon } from '../../../canvas/useTechnologyIcon';
import { GENERIC_TECHNOLOGY_ICON } from '../../../nodes/technology';
import { technologyShapes } from './technologyShapes';
import { ToolGlyph } from './ToolGlyph';

interface ShapePickerProps {
  /** The trigger's own rect, so the panel hangs off the button rather than off a bare point. */
  anchorRect: DOMRect;
  /** The trigger itself: a press on it is its own toggle, not an "outside" press. */
  trigger: HTMLElement | null;
  /** The tool in hand, marked in the list. */
  armedId: string | null;
  onPick: (preset: Preset) => void;
  onDismiss: () => void;
}

/** Same identity trick as `ToolbarMenu`: the anchor is already in screen coordinates. */
const identity = (point: PlacementPoint) => point;
const CLEARANCES = { gap: 8, top: 8, bottom: 12, left: 8, right: 8 };

const GROUPS: { title: string; presets: Preset[] }[] = [
  { title: 'Annotate', presets: PRESETS },
  { title: 'Architecture', presets: DEV_PRESETS },
];

/**
 * Every shape, by name.
 *
 * The rail keeps only what a diagram reaches for constantly, as pictures. This is where the rest
 * live — and where all of them are spelled out: the picture, the name, a line on what it is for,
 * and its key. So a rail that got shorter did not get harder to read: nothing is reachable only by
 * guessing what a glyph means, and a word typed here finds a shape by any of the names people use
 * for it ("cache", "user", "topic"), the same ones ⌘K knows.
 *
 * A technology's name finds the shape that technology is (`technologyShapes`): "kafka" offers a
 * Queue that arrives as an Apache Kafka topic, logo and all — so "how do I draw Redis?" is answered
 * by typing Redis.
 *
 * Structurally `ToolbarMenu` with a search field, rather than that menu grown a second mode: its
 * rows are commands that run and close, these are a filtered list driven from a text field.
 */
export function ShapePicker({ anchorRect, trigger, armedId, onPick, onDismiss }: ShapePickerProps) {
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });

  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.width > 0 && rect.height > 0 && (rect.width !== measuredSize.width || rect.height !== measuredSize.height)) {
      setMeasuredSize({ width: rect.width, height: rect.height });
    }
  });

  useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  const searching = query.trim().length > 0;
  // Browsing keeps the two families apart; a search is one list, best match first.
  const sections = useMemo(() => {
    if (!searching) return GROUPS;
    // A shape named what was typed comes first; then the technologies it names, which are a more
    // exact answer than a shape that merely lists the word among its other names ("kafka" is an
    // Apache Kafka topic before it is any Queue).
    const first = query.trim().toLowerCase().split(/\s+/)[0]!;
    const shapes = searchPresets(query);
    const named = shapes.filter((preset) => preset.label.toLowerCase().includes(first));
    return [
      { title: '', presets: named },
      { title: 'Technologies', presets: technologyShapes(query, { guess: named.length === 0 }) },
      { title: named.length === shapes.length ? '' : 'Shapes', presets: shapes.filter((preset) => !named.includes(preset)) },
    ].filter((section) => section.presets.length > 0);
  }, [searching, query]);
  const flat = useMemo(() => sections.flatMap((section) => section.presets), [sections]);
  const at = Math.min(highlight, Math.max(0, flat.length - 1));

  const latest = useRef({ flat, at, onPick, onDismiss });
  latest.current = { flat, at, onPick, onDismiss };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { flat, at, onPick, onDismiss } = latest.current;
      // While it's open the picker owns bare keys, like the menus beside it: a letter is a search,
      // never a shape dropped behind the panel. ⌘ chords still reach the editor.
      if (!event.metaKey && !event.ctrlKey && !isEditableTarget(event.target)) event.stopPropagation();
      switch (event.key) {
        case 'Escape':
          event.stopPropagation();
          onDismiss();
          return;
        case 'Tab':
          event.preventDefault();
          onDismiss();
          return;
        case 'ArrowDown':
          event.preventDefault();
          setHighlight(Math.min(flat.length - 1, at + 1));
          return;
        case 'ArrowUp':
          event.preventDefault();
          setHighlight(Math.max(0, at - 1));
          return;
        case 'Enter': {
          // Composing (an IME's Enter confirms the word, not the choice).
          if (event.isComposing) return;
          event.preventDefault();
          const preset = flat[at];
          if (preset) onPick(preset);
          return;
        }
        case 'k':
        case 'K':
          // ⌘K opens the palette: step aside rather than stay open under it.
          if (event.metaKey || event.ctrlKey) onDismiss();
          return;
        default:
          return;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger?.contains(target)) return;
      if (panel.current && !panel.current.contains(target)) latest.current.onDismiss();
    };
    const onResize = () => latest.current.onDismiss();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);
    // Deferred so the click that opened the picker isn't itself the outside-click that closes it.
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [trigger]);

  const anchors = anchorsForRect({ x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height });
  const placement = resolvePlacement('below', anchors, identity, measuredSize, CLEARANCES);
  const transform = placementTransform(placement, anchors, measuredSize, CLEARANCES, identity, identity);

  return (
    <div
      ref={panel}
      className="dc-context-menu dc-shape-picker"
      role="dialog"
      aria-label="All shapes"
      style={{ transform }}
      // Keep the caret in the search field: a press on a row or a heading is not a focus move.
      onPointerDown={(event) => {
        if (event.target !== input.current) event.preventDefault();
      }}
    >
      <input
        ref={input}
        type="text"
        className="dc-shape-picker-search"
        role="combobox"
        aria-label="Search shapes"
        aria-expanded="true"
        aria-controls="dc-shape-picker-list"
        aria-activedescendant={flat[at] ? `dc-shape-option-${flat[at].id}` : undefined}
        aria-autocomplete="list"
        placeholder="Search shapes — try “cache” or “kafka”"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
      />
      <div id="dc-shape-picker-list" className="dc-shape-picker-list" role="listbox" aria-label="Shapes">
        {sections.map((section) => (
          <div key={section.title || 'results'} role="group" aria-label={section.title || 'Shapes'}>
            {section.title && <div className="dc-shape-picker-heading" aria-hidden="true">{section.title}</div>}
            {section.presets.map((preset) => {
              const row = flat.indexOf(preset);
              return (
                <div
                  key={preset.id}
                  id={`dc-shape-option-${preset.id}`}
                  role="option"
                  aria-selected={row === at}
                  className="dc-context-menu-item dc-shape-option"
                  data-highlighted={row === at ? 'true' : undefined}
                  data-armed={preset.id === armedId ? 'true' : undefined}
                  onPointerMove={() => {
                    if (latest.current.at !== row) setHighlight(row);
                  }}
                  onClick={() => onPick(preset)}
                >
                  <span className="dc-shape-option-glyph" aria-hidden="true">
                    {preset.technology ? <TechnologyLogo technology={preset.technology} /> : <ToolGlyph id={preset.id} />}
                  </span>
                  <span className="dc-toolbar-menu-text">
                    <span className="dc-context-menu-title">{preset.label}</span>
                    <span className="dc-toolbar-menu-detail">{preset.hint}</span>
                  </span>
                  {preset.shortcut && (
                    <span className="dc-context-menu-kbd" aria-hidden="true">
                      <kbd>{preset.shortcut}</kbd>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && (
          <p className="dc-shape-picker-empty" role="status">
            No shape or technology goes by “{query.trim()}”. {MOD_SYMBOL}K searches everything else.
          </p>
        )}
      </div>
      <p className="dc-shape-picker-foot">Or press a shape’s key over the canvas.</p>
    </div>
  );
}

/** A technology's own logo, loaded the way the canvas loads it; the neutral mark until it arrives. */
function TechnologyLogo({ technology }: { technology: string }) {
  const icon = useTechnologyIcon(technology) ?? GENERIC_TECHNOLOGY_ICON;
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={icon.path} fill="currentColor" />
    </svg>
  );
}
