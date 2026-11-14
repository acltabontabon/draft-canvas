import { useMemo, useState } from 'react';
import type { DraftDocument } from '../../document/types';
import { renderDocumentSvg, type ExportOptions } from '../../render/svg/document';
import { themeFor, type ThemeName } from '../../render/theme/tokens';
import { Icon, type IconName } from '../common/Icon';
import { useTechnologyIcons } from '../../canvas/useTechnologyIcon';
import { ExportInspector } from './ExportInspector';

export type ArtifactVisual =
  | {
      type: 'thumbnail';
      document: DraftDocument;
      theme: ThemeName;
      options: ExportOptions;
      /** Stable identity for `options.only`, which is a fresh `Set` every render. */
      onlyKey: string;
      /**
       * Given the layout size; the caller applies its own scale, because for a PNG the scale that
       * fits the browser's canvas limits depends on that size and is what the tile should quote.
       */
      describe: (width: number, height: number) => string;
    }
  | { type: 'file'; icon: IconName; badge: string; meta: string };

/**
 * What you'll get, shown beside how you'll get it: a live thumbnail from the very renderer the
 * export uses (so palette, transparency, and "Selection only" all show up here before a file ever
 * exists), or a file glyph for text formats — never a rendered Mermaid/PlantUML diagram. The
 * filename is the exact one the download will carry.
 *
 * The thumbnail is a button: it opens the same image large (`ExportInspector`), where its text can
 * be read at the size it is drawn before a file is made.
 */
export function ExportArtifact({
  fileName,
  visual,
  empty,
}: {
  fileName: string;
  visual: ArtifactVisual;
  empty?: boolean;
}) {
  return (
    <figure className="dc-export-artifact" data-empty={empty ? 'true' : undefined}>
      {visual.type === 'thumbnail' ? (
        <Thumbnail visual={visual} fileName={fileName} empty={empty} />
      ) : (
        <>
          <div className="dc-export-stage dc-export-stage-grid">
            {/* Wrapper carries the drop shadow; the page carries the folded-corner clip — a shadow
                on the clipped element itself would be clipped away with the corner. */}
            <div className="dc-export-file" aria-hidden="true" key={visual.badge}>
              <div className="dc-export-file-page">
                <Icon name={visual.icon} size={17} />
              </div>
              <span className="dc-export-file-badge">{visual.badge}</span>
            </div>
          </div>
          <Caption fileName={fileName} meta={visual.meta} />
        </>
      )}
    </figure>
  );
}

function Thumbnail({
  visual,
  fileName,
  empty,
}: {
  visual: Extract<ArtifactVisual, { type: 'thumbnail' }>;
  fileName: string;
  empty?: boolean;
}) {
  const { document, theme, options, onlyKey, describe } = visual;
  const transparent = options.transparent === true;
  const technologyRevision = useTechnologyIcons(document.nodes);

  // Keyed on primitives, not `options` itself — the parent rebuilds that object (and its `only`
  // Set) on every render, which would otherwise re-render the whole diagram on each keystroke.
  const rendered = useMemo(() => {
    if (empty) return null;
    try {
      return renderDocumentSvg(document, options);
    } catch {
      return null;
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [document, theme, transparent, onlyKey, options.selectedFlowId, options.preset, options.openPoints, empty, technologyRevision]);

  const src = useMemo(
    () => (rendered ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}` : null),
    [rendered],
  );

  const meta = rendered ? describe(rendered.width, rendered.height) : 'Preview unavailable';
  const [inspecting, setInspecting] = useState(false);
  const background = transparent ? undefined : themeFor(theme).canvas;
  // A button only while there is an image to open: an empty stage is not a control.
  const Stage = src ? 'button' : 'div';

  return (
    <>
      <Stage
        className="dc-export-stage"
        data-transparent={transparent ? 'true' : undefined}
        style={background === undefined ? undefined : { background }}
        {...(src ? { type: 'button' as const, title: 'Inspect at actual size', 'aria-label': 'Inspect image at actual size', onClick: () => setInspecting(true) } : {})}
      >
        {src ? (
          // Keyed on the look, so a palette/transparency/selection change gets the same quick
          // settle-in the panel does, rather than an abrupt swap.
          <img
            key={`${theme}-${transparent}-${onlyKey}-${options.selectedFlowId ?? ''}-${options.openPoints === false ? 'plain' : 'marked'}`}
            src={src}
            alt=""
            draggable={false}
          />
        ) : (
          <Icon name="image" size={20} />
        )}
        {src && (
          <span className="dc-export-stage-hint" aria-hidden="true">
            <Icon name="search" size={12} />
            Inspect
          </span>
        )}
      </Stage>
      <Caption fileName={fileName} meta={meta} />
      {inspecting && src && rendered && (
        <ExportInspector
          src={src}
          width={rendered.width}
          height={rendered.height}
          fileName={fileName}
          meta={meta}
          background={background}
          onClose={() => setInspecting(false)}
        />
      )}
    </>
  );
}

function Caption({ fileName, meta }: { fileName: string; meta: string }) {
  // `fileNameFor` slugs the title to `[a-z0-9-]`, so the first dot is where the extension starts.
  // Keep the extension beside a wrapping base so the file type stays easy to identify.
  const dot = fileName.indexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '';
  return (
    <figcaption className="dc-export-caption">
      <span className="dc-export-filename" title={fileName}>
        <span className="dc-export-filename-base">{base}</span>
        <span className="dc-export-filename-ext">{extension}</span>
      </span>
      <span className="dc-export-meta">{meta}</span>
    </figcaption>
  );
}
