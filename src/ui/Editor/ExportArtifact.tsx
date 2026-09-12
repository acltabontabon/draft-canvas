import { useMemo } from 'react';
import type { DraftDocument } from '../../document/types';
import type { GifSpeed } from '../../export';
import { renderDocumentSvg, type ExportOptions } from '../../render/svg/document';
import { themeFor, type ThemeName } from '../../render/theme/tokens';
import { Icon, type IconName } from '../common/Icon';

export type ArtifactVisual =
  | {
      type: 'thumbnail';
      document: DraftDocument;
      theme: ThemeName;
      options: ExportOptions;
      /** Stable identity for `options.only`, which is a fresh `Set` every render. */
      onlyKey: string;
      /** PNG exports at 2× — the tile reports the real output size, not the layout size. */
      scale: number;
      describe: (width: number, height: number) => string;
      motion?: { speed: GifSpeed; loop: boolean };
    }
  | { type: 'file'; icon: IconName; badge: string; meta: string };

/**
 * What you'll get, shown beside how you'll get it: a live thumbnail from the very renderer the
 * export uses (so palette, transparency, and "Selection only" all show up here before a file ever
 * exists), or a file glyph for text formats — never a rendered Mermaid/PlantUML diagram. The
 * filename is the exact one the download will carry.
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
  const { document, theme, options, onlyKey, scale, describe, motion } = visual;
  const transparent = options.transparent === true;

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
  }, [document, theme, transparent, onlyKey, options.selectedFlowId, options.preset, empty]);

  const src = useMemo(
    () => (rendered ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}` : null),
    [rendered],
  );

  const meta = rendered ? describe(rendered.width * scale, rendered.height * scale) : 'No Flow yet';

  return (
    <>
      <div
        className="dc-export-stage"
        data-transparent={transparent ? 'true' : undefined}
        style={transparent ? undefined : { background: themeFor(theme).canvas }}
      >
        {src ? (
          // Keyed on the look, so a palette/transparency/selection change gets the same quick
          // settle-in the panel does, rather than an abrupt swap.
          <img
            key={`${theme}-${transparent}-${onlyKey}-${options.selectedFlowId ?? ''}`}
            src={src}
            alt=""
            draggable={false}
          />
        ) : (
          <Icon name="play" size={20} />
        )}
        {motion && src && (
          <>
            <span className="dc-export-play" aria-hidden="true">
              <Icon name="play" size={11} />
            </span>
            <span
              className="dc-export-progress"
              aria-hidden="true"
              data-speed={motion.speed}
              data-loop={motion.loop ? 'true' : undefined}
              // Re-mounts the bar when speed/loop change so the new pacing is visible at once.
              key={`${motion.speed}-${motion.loop}`}
            />
          </>
        )}
      </div>
      <Caption fileName={fileName} meta={meta} />
    </>
  );
}

function Caption({ fileName, meta }: { fileName: string; meta: string }) {
  // `fileNameFor` slugs the title to `[a-z0-9-]`, so the first dot is where the extension starts.
  // A long title truncates its base, never the extension — that's the part that says what it is.
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
