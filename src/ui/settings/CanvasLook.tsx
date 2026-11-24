import { useRef, useState, type CSSProperties } from 'react';
import { type BackdropScale, type BackdropStrength, type DocumentStyle, type StyleAsset } from '../../document/style';
import { importSvgArt, MAX_SVG_BYTES } from '../../import/svgArt';
import { backdropTile } from '../../render/style/backdrop';
import { BUILTIN_BACKDROPS, isBuiltinBackdrop } from '../../render/style/backdrops';
import { BRAND_SWATCHES, brandOf, CANVAS_SWATCHES, canvasOf, paletteOf, schemesForCanvas, STYLE_PALETTES, withBrand, type StylePalette } from '../../render/style/palettes';
import { resolveStyle } from '../../render/style/resolve';
import { THEMES, type ThemeName } from '../../render/theme/tokens';
import { Icon } from '../common/Icon';
import { SegmentedControl } from '../common/SegmentedControl';
import { PickHead, SettingRow } from './layout';

type Edit = (recipe: (style: DocumentStyle) => DocumentStyle) => void;

const STRENGTHS: { value: BackdropStrength; label: string }[] = [
  { value: 'faint', label: 'Faint' },
  { value: 'regular', label: 'Regular' },
  { value: 'strong', label: 'Strong' },
];
const SCALES: { value: BackdropScale; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'regular', label: 'Regular' },
  { value: 'large', label: 'Large' },
];

/** `style` drawing on `asset` (or on nothing), with whatever drawing it drew on before let go. */
function withBackdrop(style: DocumentStyle, asset: StyleAsset | null, keep?: Pick<NonNullable<DocumentStyle['backdrop']>, 'strength' | 'scale'>): DocumentStyle {
  const was = style.backdrop?.art;
  const inUse = new Set(Object.values(style.shapes ?? {}).map((shape) => shape.art));
  const assets = (style.assets ?? []).filter((entry) => entry.id !== asset?.id && (entry.id !== was || inUse.has(entry.id)));
  const { backdrop: _backdrop, assets: _assets, ...rest } = style;
  if (!asset) return assets.length > 0 ? { ...rest, assets } : rest;
  return { ...rest, backdrop: { art: asset.id, ...(keep?.strength ? { strength: keep.strength } : {}), ...(keep?.scale ? { scale: keep.scale } : {}) }, assets: [...assets, asset] };
}

/**
 * The canvas itself: the colours a diagram is drawn in, the colour of the paper under it, and
 * what is printed on that paper.
 *
 * Three steps from broad to particular. A set of colours changes everything at once. A canvas
 * colour of one's own (a brand colour, say) keeps the diagram readable on it: `schemesForCanvas`
 * works the rest out. A backdrop is one drawing repeated behind the diagram, from the ones Draft
 * Canvas comes with or an SVG of one's own, read by the same importer as a shape's drawing.
 */
export function CanvasLook({ style, theme, edit }: { style: DocumentStyle; theme: ThemeName; edit: Edit }) {
  const palette = paletteOf(style);
  const resolved = resolveStyle(style);
  const canvas = resolved.theme(theme).canvas;
  const named = canvasOf(style, theme);
  const custom = palette === null && named !== undefined && !CANVAS_SWATCHES.some((swatch) => swatch.colour === named);
  const picker = useRef<HTMLInputElement>(null);

  return (
    <>
      <div className="dc-look-block">
        <PickHead label="Colours" description={palette ? 'For the shapes, the lines and the canvas.' : 'This style has its own. A set replaces them.'} />
        <div className="dc-look-palettes" role="radiogroup" aria-label="Colours">
          {STYLE_PALETTES.map((entry) => (
            <PaletteCard key={entry.id} palette={entry} theme={theme} checked={palette?.id === entry.id} onPick={() => edit((current) => withSchemes(current, entry.schemes))} />
          ))}
        </div>
      </div>

      <div className="dc-look-block">
        <PickHead label="Canvas colour" description="Any colour, your brand’s included. Words and shapes stay readable on it." />
        <div className="dc-look-swatches" role="radiogroup" aria-label="Canvas colour">
          {CANVAS_SWATCHES.map((swatch) => (
            <label key={swatch.colour} className="dc-look-swatch" title={swatch.label}>
              <input
                type="radio"
                name="style-canvas"
                className="dc-sr-only"
                aria-label={swatch.label}
                checked={palette === null && named === swatch.colour}
                onChange={() => edit((current) => withSchemes(current, schemesForCanvas(swatch.colour)))}
              />
              <span style={{ background: swatch.colour }} />
            </label>
          ))}
          <label className="dc-look-swatch dc-look-swatch-custom" data-on={custom ? '' : undefined} title="A colour of your own">
            <input
              ref={picker}
              type="color"
              className="dc-look-colour-input"
              aria-label="A canvas colour of your own"
              value={canvas}
              onChange={(event) => edit((current) => withSchemes(current, schemesForCanvas(event.target.value.toLowerCase())))}
            />
            <span style={custom ? { background: canvas } : undefined}>{!custom && <Icon name="plus" size={13} />}</span>
          </label>
          {custom && <code className="dc-look-hex">{canvas}</code>}
        </div>
      </div>

      <BrandColour style={style} theme={theme} edit={edit} />

      <BackdropPicker style={style} theme={theme} edit={edit} />
    </>
  );
}

/** `style` in other colours, still marked in the brand colour it had. */
function withSchemes(style: DocumentStyle, schemes: DocumentStyle['schemes']): DocumentStyle {
  return withAllSchemes(style, withBrand(schemes, brandOf(style)));
}

function withAllSchemes(style: DocumentStyle, schemes: DocumentStyle['schemes']): DocumentStyle {
  const { schemes: _schemes, ...rest } = style;
  return schemes ? { ...rest, schemes } : rest;
}

/**
 * The one colour everything chosen and everything to press is marked in: the selection ring on the
 * canvas, the tool in use, Share. A brand's own colour here, with its canvas and backdrop, is most
 * of what makes a diagram look like it came from somewhere.
 */
function BrandColour({ style, theme, edit }: { style: DocumentStyle; theme: ThemeName; edit: Edit }) {
  const brand = brandOf(style);
  const shown = resolveStyle(style).theme(theme).selection;
  const custom = brand !== undefined && !BRAND_SWATCHES.some((swatch) => swatch.colour === brand);
  const set = (colour: string | undefined) => edit((current) => withAllSchemes(current, withBrand(current.schemes, colour)));
  return (
    <div className="dc-look-block">
      <PickHead label="Brand colour" description={brand && shown !== brand ? 'Too close to the canvas to be seen, so the usual one is used.' : 'Marks what is selected and what to press.'} />
      <div className="dc-look-swatches" role="radiogroup" aria-label="Brand colour">
        <label className="dc-look-swatch dc-look-swatch-auto" title="The usual colour">
          <input type="radio" name="style-brand" className="dc-sr-only" aria-label="The usual colour" checked={brand === undefined} onChange={() => set(undefined)} />
          <span />
        </label>
        {BRAND_SWATCHES.map((swatch) => (
          <label key={swatch.colour} className="dc-look-swatch" title={swatch.label}>
            <input type="radio" name="style-brand" className="dc-sr-only" aria-label={swatch.label} checked={brand === swatch.colour} onChange={() => set(swatch.colour)} />
            <span style={{ background: swatch.colour }} />
          </label>
        ))}
        <label className="dc-look-swatch dc-look-swatch-custom" data-on={custom ? '' : undefined} title="A colour of your own">
          <input type="color" className="dc-look-colour-input" aria-label="A brand colour of your own" value={brand ?? shown} onChange={(event) => set(event.target.value.toLowerCase())} />
          <span style={custom ? { background: brand } : undefined}>{!custom && <Icon name="plus" size={13} />}</span>
        </label>
        {custom && <code className="dc-look-hex">{brand}</code>}
      </div>
    </div>
  );
}

/** A set of colours as a scrap of its own canvas with three shapes on it. */
function PaletteCard({ palette, theme, checked, onPick }: { palette: StylePalette; theme: ThemeName; checked: boolean; onPick: () => void }) {
  const scheme = palette.schemes?.[theme];
  // The built-in colours by value, not by variable: the panel may itself be wearing another style's.
  const builtin = THEMES[theme];
  const chip = (accent: 'teal' | 'blue' | 'amber'): CSSProperties => ({
    background: scheme?.accents?.[accent]?.fill ?? builtin.accents[accent].fill,
    borderColor: scheme?.accents?.[accent]?.line ?? builtin.accents[accent].line,
  });
  return (
    <label className="dc-look-palette" title={palette.description}>
      <input type="radio" name="style-palette" className="dc-sr-only" aria-label={`${palette.label}: ${palette.description}`} checked={checked} onChange={onPick} />
      <span className="dc-look-palette-paper" style={{ background: scheme?.canvas ?? builtin.canvas }} aria-hidden="true">
        <span style={chip('teal')} />
        <span style={chip('blue')} />
        <span style={chip('amber')} />
      </span>
      <span className="dc-look-palette-name">{palette.label}</span>
    </label>
  );
}

/** One backdrop on the style's own canvas, as it will repeat. */
function Tile({ style, asset, theme }: { style: DocumentStyle; asset: StyleAsset | null; theme: ThemeName }) {
  const shown = resolveStyle(asset ? withBackdrop(style, asset) : withBackdrop(style, null));
  const tile = backdropTile(shown, theme);
  return (
    <span
      className="dc-look-backdrop-paper"
      aria-hidden="true"
      style={{ backgroundColor: shown.theme(theme).canvas, ...(tile ? { backgroundImage: tile.uri, backgroundSize: `${tile.width * 0.5}px ${tile.height * 0.5}px` } : {}) }}
    />
  );
}

function BackdropPicker({ style, theme, edit }: { style: DocumentStyle; theme: ThemeName; edit: Edit }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const current = style.backdrop;
  const own = current && !isBuiltinBackdrop(current.art) ? style.assets?.find((asset) => asset.id === current.art) : undefined;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > MAX_SVG_BYTES) {
      setError('This picture is too detailed to repeat as a backdrop. Simplify it and try again.');
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError('That file could not be read.');
      return;
    }
    const result = importSvgArt(text, 'original');
    if (!result.ok) {
      setError(result.message);
      return;
    }
    edit((now) => withBackdrop(now, result.asset, now.backdrop));
  };

  return (
    <div className="dc-look-block">
      <PickHead label="Backdrop" description="A pattern behind the diagram. Your own SVG repeats edge to edge." />
      <div className="dc-look-backdrops" role="radiogroup" aria-label="Backdrop">
        <label className="dc-look-backdrop">
          <input type="radio" name="style-backdrop" className="dc-sr-only" aria-label="No backdrop" checked={!current} onChange={() => edit((now) => withBackdrop(now, null))} />
          <Tile style={style} asset={null} theme={theme} />
          <span>None</span>
        </label>
        {own && (
          <label className="dc-look-backdrop">
            <input type="radio" name="style-backdrop" className="dc-sr-only" aria-label="This style’s own backdrop" checked readOnly />
            <Tile style={style} asset={own} theme={theme} />
            <span>Its own</span>
          </label>
        )}
        {BUILTIN_BACKDROPS.map((entry) => (
          <label key={entry.id} className="dc-look-backdrop" title={entry.description}>
            <input
              type="radio"
              name="style-backdrop"
              className="dc-sr-only"
              aria-label={`${entry.label}: ${entry.description}`}
              checked={current?.art === entry.asset.id}
              onChange={() => edit((now) => withBackdrop(now, entry.asset, now.backdrop))}
            />
            <Tile style={style} asset={entry.asset} theme={theme} />
            <span>{entry.label}</span>
          </label>
        ))}
        <button type="button" className="dc-look-backdrop dc-look-backdrop-add" onClick={() => input.current?.click()}>
          <span className="dc-look-backdrop-paper" aria-hidden="true">
            <Icon name="upload" size={16} />
          </span>
          <span>Your SVG…</span>
        </button>
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
      </div>
      {error && (
        <p className="dc-prefs-note" data-tone="error" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </p>
      )}
      {current && (
        <div className="dc-prefs-rows">
          <SettingRow
            label="Strength"
            control={
              <SegmentedControl
                name="backdrop-strength"
                legend="Backdrop strength"
                value={current.strength ?? 'regular'}
                options={STRENGTHS}
                onChange={(strength) => edit((now) => (now.backdrop ? { ...now, backdrop: { ...now.backdrop, strength } } : now))}
              />
            }
          />
          <SettingRow
            label="Size"
            control={
              <SegmentedControl
                name="backdrop-scale"
                legend="Backdrop size"
                value={current.scale ?? 'regular'}
                options={SCALES}
                onChange={(scale) => edit((now) => (now.backdrop ? { ...now, backdrop: { ...now.backdrop, scale } } : now))}
              />
            }
          />
        </div>
      )}
    </div>
  );
}
