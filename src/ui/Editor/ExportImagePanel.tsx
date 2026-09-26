import { SegmentedControl } from '../common/SegmentedControl';
import type { ThemeName } from '../../render/theme/tokens';
import type { ImageFormat } from './exportTypes';

interface ImagePanelProps {
  format: ImageFormat;
  onFormatChange: (format: ImageFormat) => void;
  paletteName: ThemeName;
  onPaletteChange: (name: ThemeName) => void;
  transparent: boolean;
  onTransparentChange: (value: boolean) => void;
  hasBackground: boolean;
  includeBackground: boolean;
  onIncludeBackgroundChange: (value: boolean) => void;
  selectionCount: number;
  selectionOnly: boolean;
  onSelectionOnlyChange: (value: boolean) => void;
  /** Whether anything in the picture carries an open-point marker — the checkbox only shows then. */
  hasOpenPoints: boolean;
  includeOpenPoints: boolean;
  onIncludeOpenPointsChange: (value: boolean) => void;
}

const DESCRIPTIONS: Record<ImageFormat, string> = {
  png: 'High-resolution image for chat, docs and slides.',
  svg: 'Scalable vector output for docs and READMEs.',
};

export function ExportImagePanel({
  format,
  onFormatChange,
  paletteName,
  onPaletteChange,
  transparent,
  onTransparentChange,
  hasBackground,
  includeBackground,
  onIncludeBackgroundChange,
  selectionCount,
  selectionOnly,
  onSelectionOnlyChange,
  hasOpenPoints,
  includeOpenPoints,
  onIncludeOpenPointsChange,
}: ImagePanelProps) {
  return (
    <div className="dc-export-panel">
      <div className="dc-export-row">
        <SegmentedControl
          name="image-format"
          legend="Image format"
          value={format}
          onChange={onFormatChange}
          options={[
            { value: 'png', label: 'PNG' },
            { value: 'svg', label: 'SVG' },
          ]}
        />
        <label className="dc-export-field">
          <span>Palette</span>
          <select
            className="dc-select"
            value={paletteName}
            onChange={(event) => onPaletteChange(event.target.value as ThemeName)}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
      </div>

      <div className="dc-export-checks">
        <label className="dc-check">
          <input
            type="checkbox"
            checked={transparent}
            onChange={(event) => onTransparentChange(event.target.checked)}
          />
          <span>Transparent</span>
        </label>

        {hasBackground && (
          <label className="dc-check">
            <input
              type="checkbox"
              checked={includeBackground}
              onChange={(event) => onIncludeBackgroundChange(event.target.checked)}
            />
            <span>Canvas background</span>
          </label>
        )}

        {hasOpenPoints && (
          // Kept by default: an image that quietly dropped them would make every unsettled assumption
          // look decided. Leaving them out is a plain choice about the picture, worded as one.
          <label className="dc-check" title="The tabs marking what is still open, with a key naming them. Untick for an image without them.">
            <input
              type="checkbox"
              checked={includeOpenPoints}
              onChange={(event) => onIncludeOpenPointsChange(event.target.checked)}
            />
            <span>Open point markers</span>
          </label>
        )}

        <label className="dc-check" data-disabled={selectionCount === 0 ? 'true' : undefined}>
          <input
            type="checkbox"
            checked={selectionOnly}
            disabled={selectionCount === 0}
            onChange={(event) => onSelectionOnlyChange(event.target.checked)}
          />
          <span>
            Selection only
            {selectionCount > 0 && <span className="dc-muted"> ({selectionCount})</span>}
          </span>
        </label>
      </div>

      <p className="dc-export-panel-description">{DESCRIPTIONS[format]}</p>
    </div>
  );
}
