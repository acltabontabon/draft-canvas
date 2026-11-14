import type { InkColor } from '../../../document/types';
import { cancelSmartInk, flushSmartInk } from '../../../canvas/inkSession';
import { inkColor, INK_SIZES } from '../../../render/ink';
import { useUiStore, type InkSizeName, type PencilTool } from '../../../store/uiStore';
import { useThemeValue } from '../../../theme/useTheme';
import { Tooltip } from '../../common/Tooltip';
import { ToolGlyph } from '../toolbar/ToolGlyph';

const PEN_COLORS: InkColor[] = ['graphite', 'red', 'blue', 'green'];
const HIGHLIGHTER_COLORS: InkColor[] = ['yellow', 'green', 'blue', 'red'];
const COLOR_NAMES: Record<InkColor, string> = { graphite: 'Graphite', red: 'Red', blue: 'Blue', green: 'Green', yellow: 'Yellow' };
const SIZES: Array<{ id: InkSizeName; name: string }> = [
  { id: 's', name: 'Fine' },
  { id: 'm', name: 'Medium' },
  { id: 'l', name: 'Bold' },
];

type Mode = 'sketch' | 'smart' | 'highlighter' | 'eraser';

const MODES: Array<{ id: Mode; label: string; glyph: string; key: string; title: string; description: string }> = [
  { id: 'sketch', label: 'Sketch', glyph: 'pencil', key: 'P', title: 'Sketch', description: 'Freehand ink that stays exactly as drawn.' },
  {
    id: 'smart',
    label: 'Smart ink',
    glyph: 'smart',
    key: 'P',
    title: 'Smart Ink',
    description: 'Rough boxes, circles, cylinders and arrows become real shapes and connectors. Anything else stays ink.',
  },
  { id: 'highlighter', label: 'Highlight', glyph: 'highlighter', key: 'H', title: 'Highlighter', description: 'A broad, see-through marker for emphasis.' },
  { id: 'eraser', label: 'Erase', glyph: 'eraser', key: 'E', title: 'Eraser', description: 'Drag across strokes to take them away. Shapes are never erased.' },
];

/**
 * The Pencil's few settings, under the toolbar while it is in hand — the way a whiteboard has a
 * tray, not a palette. One row: what the pencil does (sketch, Smart Ink, highlight, erase), then
 * the ink and width for that tool. Settings are a device preference (`uiStore.inkPrefs`).
 */
export function InkBar() {
  const pencil = useUiStore((state) => state.pencil);
  const prefs = useUiStore((state) => state.inkPrefs);
  const setPencil = useUiStore((state) => state.setPencil);
  const setInkPrefs = useUiStore((state) => state.setInkPrefs);
  const theme = useThemeValue();
  if (!pencil) return null;

  const mode: Mode = pencil === 'pen' ? (prefs.smart ? 'smart' : 'sketch') : pencil;
  const choose = (next: Mode) => {
    const tool: PencilTool = next === 'sketch' || next === 'smart' ? 'pen' : next;
    if (next === 'sketch' && prefs.smart) {
      cancelSmartInk();
      setInkPrefs({ smart: false });
    } else if (next === 'smart' && !prefs.smart) setInkPrefs({ smart: true });
    else if (tool !== 'pen') flushSmartInk();
    setPencil(tool);
  };
  const highlighting = pencil === 'highlighter';
  const colors = highlighting ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const color = highlighting ? prefs.highlighterColor : prefs.penColor;
  const size = highlighting ? prefs.highlighterSize : prefs.penSize;

  return (
    <div className="dc-ink-bar" role="toolbar" aria-label="Pencil" data-mode={mode}>
      <div className="dc-ink-modes" role="group" aria-label="Draw with">
        {MODES.map((option) => (
          <Tooltip key={option.id} content={{ title: option.title, description: option.description, shortcut: option.key }}>
            {(tip) => (
              <button
                type="button"
                className="dc-ink-mode"
                aria-pressed={mode === option.id}
                data-active={mode === option.id ? 'true' : undefined}
                onClick={() => choose(option.id)}
                {...tip}
              >
                <ToolGlyph id={option.glyph} />
                <span>{option.label}</span>
              </button>
            )}
          </Tooltip>
        ))}
      </div>
      {pencil === 'eraser' ? (
        <span className="dc-ink-hint">Drag across a stroke to erase it</span>
      ) : (
        <>
          <span className="dc-ink-sep" aria-hidden="true" />
          <div className="dc-ink-swatches" role="group" aria-label="Ink">
            {colors.map((option) => (
              <button
                key={option}
                type="button"
                className="dc-ink-swatch"
                aria-label={COLOR_NAMES[option]}
                aria-pressed={color === option}
                title={COLOR_NAMES[option]}
                data-active={color === option ? 'true' : undefined}
                style={{ '--dc-ink-swatch': inkColor(option, theme.name) } as React.CSSProperties}
                onClick={() => setInkPrefs(highlighting ? { highlighterColor: option } : { penColor: option })}
              />
            ))}
          </div>
          <span className="dc-ink-sep" aria-hidden="true" />
          <div className="dc-ink-sizes" role="group" aria-label="Width">
            {SIZES.map((option) => {
              const px = INK_SIZES[highlighting ? 'highlighter' : 'pen'][option.id];
              return (
                <button
                  key={option.id}
                  type="button"
                  className="dc-ink-size"
                  aria-label={option.name}
                  aria-pressed={size === option.id}
                  title={option.name}
                  data-active={size === option.id ? 'true' : undefined}
                  onClick={() => setInkPrefs(highlighting ? { highlighterSize: option.id } : { penSize: option.id })}
                >
                  <span style={{ width: Math.min(14, Math.max(3, highlighting ? px / 2.2 : px * 1.4)), height: Math.min(14, Math.max(3, highlighting ? px / 2.2 : px * 1.4)) }} />
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
