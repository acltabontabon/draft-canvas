import { useRef, useState } from 'react';
import { artSlotOf, type DocumentStyle, type ShapeStyle, type StyleFit } from '../../document/style';
import type { DraftNodeType } from '../../document/types';
import { importSvgArt, MAX_SVG_BYTES, type SvgArtMode } from '../../import/svgArt';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { SegmentedControl } from '../common/SegmentedControl';
import { SettingRow } from './layout';

const MODES: { value: SvgArtMode; label: string; name: string }[] = [
  { value: 'diagram', label: 'Diagram’s', name: 'Diagram’s colours' },
  { value: 'original', label: 'Its own', name: 'Its own colours' },
];
const FITS: { value: StyleFit; label: string; name: string }[] = [
  { value: 'contain', label: 'Keep shape', name: 'Keep the drawing’s shape' },
  { value: 'stretch', label: 'Fill', name: 'Fill the space' },
];

interface ShapeArtworkProps {
  style: DocumentStyle;
  /** The key being edited: a type, or a type and kind. */
  shapeKey: string;
  type: DraftNodeType;
  kind: string | undefined;
  /** What this is, in words: "data store", "cache data store". */
  what: string;
  /** Every one of this type, in words: "every data store". */
  family: string;
  edit: (recipe: (style: DocumentStyle) => DocumentStyle) => void;
  /** The style as it is after an edit, to see whether a drawing was kept. */
  current: () => DocumentStyle;
}

/** A shape entry with its drawing swapped out, and nothing left behind when that empties it. */
function withDrawing(style: DocumentStyle, key: string, change: (shape: ShapeStyle) => ShapeStyle): DocumentStyle {
  const shapes = { ...(style.shapes ?? {}) };
  const { art: _art, fit: _fit, builtin: _builtin, ...rest } = shapes[key] ?? {};
  const next = change(rest);
  if (Object.keys(next).length === 0) delete shapes[key];
  else shapes[key] = next;
  const out = { ...style };
  if (Object.keys(shapes).length === 0) delete out.shapes;
  else out.shapes = shapes;
  return out;
}

/**
 * A drawing of the person's own for one shape: choose an SVG, see it, use it.
 *
 * The file never reaches the style as a file. `importSvgArt` reads it into plain path data and
 * that is all that is kept, so nothing here needs to know anything about SVG, and neither does the
 * person. What could not be kept (text, images, effects) is said in a line, not hidden.
 *
 * Shown only for shapes a drawing can stand for. A shape that holds its own content (text, a note,
 * code, a sequence, a boundary) has no drawing to replace.
 */
export function ShapeArtwork({ style, shapeKey: key, type, kind, what, family, edit, current }: ShapeArtworkProps) {
  const slot = artSlotOf(type, kind);
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<SvgArtMode>('diagram');
  // The picture last chosen, kept only while this page is open, so its colours can be read the other way.
  const [source, setSource] = useState<{ key: string; text: string } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [message, setMessage] = useState<{ key: string; tone: 'error' | 'info'; lines: string[] } | null>(null);
  if (!slot) return null;

  const own = style.shapes?.[key];
  const fromFamily = kind !== undefined && !own?.art && !own?.builtin ? style.shapes?.[type]?.art : undefined;
  const has = own?.art !== undefined;

  const adopt = (text: string, as: SvgArtMode) => {
    const result = importSvgArt(text, as);
    if (!result.ok) {
      setMessage({ key, tone: 'error', lines: [result.message] });
      return;
    }
    const { asset, notes } = result;
    edit((style) => withDrawing({ ...style, assets: [...(style.assets ?? []).filter((other) => other.id !== asset.id), asset] }, key, (shape) => ({ ...shape, art: asset.id })));
    // A style holds only so many drawings; one that did not fit is not there afterwards.
    if (current().shapes?.[key]?.art !== asset.id) {
      setMessage({ key, tone: 'error', lines: ['This style has no room for another drawing. Remove one it no longer needs.'] });
      return;
    }
    setSource({ key, text });
    setPasting(false);
    setPasted('');
    setMessage(notes.length > 0 ? { key, tone: 'info', lines: notes } : null);
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_SVG_BYTES) {
      setMessage({ key, tone: 'error', lines: ['This picture is too detailed to use as a shape. Simplify it and try again.'] });
      return;
    }
    try {
      adopt(await file.text(), mode);
    } catch {
      setMessage({ key, tone: 'error', lines: ['That file could not be read.'] });
    }
  };

  const shown = message?.key === key ? message : null;
  return (
    <>
      <SettingRow
        label="Drawing"
        description={
          has
            ? `This ${what} is drawn with your picture. Its name and its connectors stay where they are.`
            : own?.builtin
            ? `This ${what} keeps the built-in drawing.`
            : fromFamily
            ? `Drawn with the picture chosen for ${family}.`
            : `Use an SVG picture of your own in place of the built-in drawing.`
        }
        control={
          <span className="dc-prefs-artwork-actions">
            <input
              ref={input}
              type="file"
              accept=".svg,image/svg+xml"
              hidden
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                void choose(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <Button variant="quiet" className="dc-prefs-outline" icon="upload" onClick={() => input.current?.click()}>
              {has ? 'Replace…' : 'Choose SVG…'}
            </Button>
            <Button variant="quiet" className="dc-prefs-outline" aria-expanded={pasting} onClick={() => setPasting((open) => !open)}>
              Paste SVG
            </Button>
            {has && (
              <Button
                variant="quiet"
                className="dc-prefs-outline"
                icon="trash"
                onClick={() => {
                  edit((style) => withDrawing(style, key, (shape) => shape));
                  setSource(null);
                  setMessage(null);
                }}
              >
                Remove
              </Button>
            )}
            {fromFamily && (
              <Button variant="quiet" className="dc-prefs-outline" onClick={() => edit((style) => withDrawing(style, key, (shape) => ({ ...shape, builtin: true })))}>
                Use the built-in
              </Button>
            )}
            {own?.builtin && (
              <Button variant="quiet" className="dc-prefs-outline" onClick={() => edit((style) => withDrawing(style, key, (shape) => shape))}>
                Follow {family}
              </Button>
            )}
          </span>
        }
      />
      {pasting && (
        <div className="dc-prefs-paste">
          <textarea
            className="dc-prefs-paste-box"
            aria-label="SVG code"
            placeholder="<svg …>"
            spellCheck={false}
            rows={4}
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
          />
          <Button variant="quiet" className="dc-prefs-outline" disabled={pasted.trim() === ''} onClick={() => adopt(pasted, mode)}>
            Use this
          </Button>
        </div>
      )}
      {shown && (
        <p className="dc-prefs-note" data-tone={shown.tone === 'error' ? 'error' : undefined} role={shown.tone === 'error' ? 'alert' : 'status'}>
          <Icon name={shown.tone === 'error' ? 'alert' : 'info'} size={14} />
          <span>{shown.lines.join(' ')}</span>
        </p>
      )}
      {has && (
        <>
          <SettingRow
            label="Its colours"
            description={source?.key === key ? 'The diagram’s colours follow a recolour and light or dark. Its own never change.' : 'Choose the picture again to change how its colours are read.'}
            control={
              <SegmentedControl
                name={`art-mode-${key}`}
                legend="Drawing colours"
                value={mode}
                options={MODES}
                disabled={source?.key !== key}
                onChange={(next) => {
                  setMode(next);
                  if (source?.key === key) adopt(source.text, next);
                }}
              />
            }
          />
          <SettingRow
            label="Fit"
            control={
              <SegmentedControl
                name={`art-fit-${key}`}
                legend="Drawing fit"
                value={own?.fit ?? (slot === 'glyph' ? 'contain' : 'stretch')}
                options={FITS}
                onChange={(fit) => edit((style) => withDrawing(style, key, (shape) => ({ ...shape, art: own!.art!, fit })))}
              />
            }
          />
        </>
      )}
    </>
  );
}
