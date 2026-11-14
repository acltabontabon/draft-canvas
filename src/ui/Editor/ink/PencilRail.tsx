import type { InkColor } from '../../../document/types';
import { cancelSmartInk, flushSmartInk } from '../../../canvas/inkSession';
import { inkColor, INK_SIZES } from '../../../render/ink';
import { useUiStore, type InkSizeName, type PencilTool } from '../../../store/uiStore';
import { useThemeValue } from '../../../theme/useTheme';
import { Button } from '../../common/Button';
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

const MODES: Array<{ id: Mode; label: string; glyph: string; key?: string; description: string }> = [
  { id: 'sketch', label: 'Sketch', glyph: 'pencil', key: 'P', description: 'Freehand ink that stays exactly as drawn.' },
  {
    id: 'smart',
    label: 'Smart ink',
    glyph: 'smart',
    description: 'Rough boxes, circles, cylinders and arrows become real shapes and connectors. Anything else stays ink. P switches between Sketch and Smart ink.',
  },
  { id: 'highlighter', label: 'Highlight', glyph: 'highlighter', key: 'H', description: 'A broad, see-through marker for emphasis.' },
  { id: 'eraser', label: 'Erase', glyph: 'eraser', key: 'E', description: 'Drag across strokes to take them away. Shapes are never erased.' },
];

/**
 * The Pencil, unfolded in the create rail. While it is in hand the rail holds what drawing needs —
 * the four ways to draw, then the ink and the width for the one in hand — in place of the shapes,
 * which come back when Select (or Esc) puts the Pencil down. One toolbar that changes with the tool,
 * never a second bar under it.
 *
 * The tools are drawn exactly as the rail's shape tools are (`dc-tool`): a glyph, and the one in
 * hand writes its name. Ink and width are device preferences (`uiStore.inkPrefs`).
 */
export function PencilRail({ tool }: { tool: PencilTool }) {
  const prefs = useUiStore((state) => state.inkPrefs);
  const setPencil = useUiStore((state) => state.setPencil);
  const setInkPrefs = useUiStore((state) => state.setInkPrefs);
  const theme = useThemeValue();

  const mode: Mode = tool === 'pen' ? (prefs.smart ? 'smart' : 'sketch') : tool;
  const choose = (next: Mode) => {
    const nextTool: PencilTool = next === 'sketch' || next === 'smart' ? 'pen' : next;
    if (next === 'sketch' && prefs.smart) {
      cancelSmartInk();
      setInkPrefs({ smart: false });
    } else if (next === 'smart' && !prefs.smart) setInkPrefs({ smart: true });
    else if (nextTool !== 'pen') flushSmartInk();
    setPencil(nextTool);
  };
  const highlighting = tool === 'highlighter';
  const colors = highlighting ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const color = highlighting ? prefs.highlighterColor : prefs.penColor;
  const size = highlighting ? prefs.highlighterSize : prefs.penSize;

  return (
    <>
      <div className="dc-create-family dc-pencil-family" data-family="pencil">
        {MODES.map((option) => (
          <Tooltip key={option.id} content={{ title: option.label, description: option.description, shortcut: option.key }}>
            {(tip) => (
              <Button
                variant="ghost"
                className="dc-tool"
                active={mode === option.id}
                aria-pressed={mode === option.id}
                aria-label={option.label}
                onClick={() => choose(option.id)}
                {...tip}
              >
                <ToolGlyph id={option.glyph} />
                <span className="dc-tool-name">{option.label}</span>
                {option.key && (
                  <span className="dc-tool-key" aria-hidden="true">
                    {option.key}
                  </span>
                )}
              </Button>
            )}
          </Tooltip>
        ))}
      </div>
      <span className="dc-rail-separator" aria-hidden="true" />
      {tool === 'eraser' ? (
        <div className="dc-create-family dc-pencil-family">
          <span className="dc-pencil-hint">Drag to erase</span>
        </div>
      ) : (
        <>
          <div className="dc-create-family dc-pencil-family" role="group" aria-label="Ink">
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
          <span className="dc-rail-separator" aria-hidden="true" />
          <div className="dc-create-family dc-pencil-family" role="group" aria-label="Width">
            {SIZES.map((option) => {
              const px = INK_SIZES[highlighting ? 'highlighter' : 'pen'][option.id];
              const dot = Math.min(13, Math.max(3, highlighting ? px / 2.4 : px * 1.4));
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
                  <span style={{ width: dot, height: dot }} />
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
