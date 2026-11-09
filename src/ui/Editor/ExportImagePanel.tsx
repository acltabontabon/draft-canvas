import { SegmentedControl } from '../common/SegmentedControl';
import type { ThemeName } from '../../render/theme/tokens';
import { PNG_SCALES, type ImageFormat, type PngScale } from '../../export/exportTypes';

interface ImagePanelProps {
  format: ImageFormat;
  onFormatChange: (format: ImageFormat) => void;
  /** PNG only: an SVG has no pixels to multiply, so the control stays off the panel then. */
  scale: PngScale;
  onScaleChange: (scale: PngScale) => void;
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
  /** Whether a room sits below this canvas — "Every level" is only a question when one does. */
  hasRooms: boolean;
  everyLevel: boolean;
  onEveryLevelChange: (value: boolean) => void;
  /** Whether the image carries the `.draftcanvas` inside it — per format, remembered. */
  editable: boolean;
  onEditableChange: (value: boolean) => void;
}

/**
 * Two questions with answers to pick (format, look) and the rest as plain switches — in one label
 * column, so the eye reads down the edge rather than across a paragraph. What each switch does in
 * detail is its tooltip; the panel itself stays short.
 */
export function ExportImagePanel({
  format,
  onFormatChange,
  scale,
  onScaleChange,
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
  hasRooms,
  everyLevel,
  onEveryLevelChange,
  editable,
  onEditableChange,
}: ImagePanelProps) {
  return (
    <div className="dc-export-panel">
      <div className="dc-export-form">
        <span className="dc-export-label" aria-hidden="true">Format</span>
        <span className="dc-export-controls">
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
          {format === 'png' && (
            <SegmentedControl
              name="png-scale"
              legend="Scale"
              value={scale}
              onChange={onScaleChange}
              options={PNG_SCALES.map((value) => ({ value, label: `${value}×` }))}
            />
          )}
        </span>

        <span className="dc-export-label" aria-hidden="true">Look</span>
        <SegmentedControl
          name="image-palette"
          legend="Palette"
          value={paletteName}
          onChange={onPaletteChange}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />

        <span className="dc-export-label dc-export-label-top" aria-hidden="true">Options</span>
        <div className="dc-export-checks">
          <label className="dc-check" title="No canvas colour behind the diagram.">
            <input type="checkbox" checked={transparent} onChange={(event) => onTransparentChange(event.target.checked)} />
            <span>Transparent</span>
          </label>

          {hasBackground && (
            <label className="dc-check" title="The canvas background image, behind the diagram.">
              <input type="checkbox" checked={includeBackground} onChange={(event) => onIncludeBackgroundChange(event.target.checked)} />
              <span>Canvas background</span>
            </label>
          )}

          {hasOpenPoints && (
            // Kept by default: an image that quietly dropped them would make every unsettled assumption
            // look decided. Leaving them out is a plain choice about the picture, worded as one.
            <label className="dc-check" title="The tabs marking what is still open, with a key naming them. Untick for an image without them.">
              <input type="checkbox" checked={includeOpenPoints} onChange={(event) => onIncludeOpenPointsChange(event.target.checked)} />
              <span>Open point markers</span>
            </label>
          )}

          <label className="dc-check" data-disabled={selectionCount === 0 ? 'true' : undefined} title="Only the shapes selected on the canvas, and the connectors between them.">
            <input type="checkbox" checked={selectionOnly} disabled={selectionCount === 0} onChange={(event) => onSelectionOnlyChange(event.target.checked)} />
            <span>
              Selection only
              {selectionCount > 0 && <span className="dc-muted"> ({selectionCount})</span>}
            </span>
          </label>

          {!everyLevel && (
            // The picture stays a picture to every viewer; Draft Canvas reads the diagram back out of
            // it on import. On by default for SVG, where a few kilobytes of text cost nothing beside
            // the markup; off for PNG, where an image is usually meant as just an image.
            <label className="dc-check" title="Carries the whole diagram inside the image, so importing the file reopens it as a diagram. Other viewers see only the picture.">
              <input type="checkbox" checked={editable} onChange={(event) => onEditableChange(event.target.checked)} />
              <span>Editable</span>
            </label>
          )}

          {hasRooms && (
            // Only offered when a room exists below this canvas: a flat diagram has one picture, and a
            // checkbox for a second would be a question about a thing that is not in doubt.
            <label className="dc-check" title="The canvas and every room inside it, one image each, in a ZIP archive.">
              <input type="checkbox" checked={everyLevel} onChange={(event) => onEveryLevelChange(event.target.checked)} />
              <span>Every level</span>
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
