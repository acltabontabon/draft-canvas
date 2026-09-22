import { useEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { Icon } from '../../ui/common/Icon';
import { SelectionChrome } from '../../ui/Library/SelectionChrome';
import { StarterGlyph } from '../../ui/Library/StarterGlyph';
import { GLYPH_HEIGHT, GLYPH_WIDTH, type StarterShape } from '../../ui/Library/starterShapes';
import { useThumbnail } from '../thumbnails';

export interface DocTileProps {
  entryKey: string;
  name: string;
  /** One quiet line under the name — when, mostly. */
  meta?: string;
  label: string;
  /** Position in the row, for the arrival stagger. */
  index: number;
  /**
   * A document is drawn from its own contents; a folder as a folder; `more` is the row's last word; a
   * project as a stack of sheets, its newest diagram (the thumbnail) on top.
   */
  kind: 'document' | 'folder' | 'more' | 'project';
  /** For a project: how many diagrams are in it, which is how many sheets (up to three) are stacked. */
  stack?: number;
  /** The file or folder isn't there right now: drawn faint, still openable to say so. */
  missing?: boolean;
  /** A drawing already in hand (a starter's), instead of one read from the file. */
  glyph?: StarterShape;
  /** What the thumbnail is read with, and what says it has changed since it was last read. */
  thumbnail?: { key: string; load: () => Promise<string | null> };
  onOpen: () => void;
  /** The one thing a tile can have done to it besides opening it: discard a draft, forget a recent. */
  action?: { label: string; icon: 'trash' | 'close'; run: () => void };
  /** Holds work that isn't in a file yet: marked the way macOS marks a window with unsaved changes. */
  edited?: boolean;
  /** The pointer or the keyboard is on it: Home lights the connector that leads here. */
  onHot?: (hot: boolean, event?: FocusEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * A file on the desktop's Home, drawn the way a starter is: its own topology on a patch of canvas,
 * its name under it. The drawing is the diagram's — read once the tile is shown, reduced to a
 * silhouette with no words in it — so "the checkout one" is recognisable before it is opened.
 */
export function DocTile({ entryKey, name, meta, label, index, kind, stack = 0, missing, glyph, thumbnail, onOpen, action, edited, onHot, onKeyDown }: DocTileProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  // A drawing is read once its tile is on screen or nearly: a project of five hundred reads the few
  // in view, not five hundred.
  const seen = useSeen(buttonRef);
  const read = useThumbnail(thumbnail?.key ?? `none:${entryKey}`, thumbnail?.load ?? (async () => null), Boolean(thumbnail) && seen);
  const drawn = glyph ?? (read.state === 'drawn' ? read.shape : null);
  const drawsItself = kind === 'document' || kind === 'project';
  const state = glyph ? 'drawn' : drawsItself ? (thumbnail ? read.state : 'blank') : kind;

  return (
    <div className="dc-desk-tile" data-kind={kind} data-missing={missing ? '' : undefined} style={{ '--i': index } as CSSProperties}>
      <button
        ref={buttonRef}
        type="button"
        className="dc-starter"
        data-entry={entryKey}
        data-thumbnail={state}
        aria-label={label}
        onClick={onOpen}
        onPointerEnter={() => onHot?.(true)}
        onPointerLeave={() => onHot?.(false)}
        onFocus={(event) => onHot?.(true, event)}
        onBlur={() => onHot?.(false)}
        onKeyDown={onKeyDown}
      >
        <span
          className="dc-starter-swatch"
          style={
            kind === 'project'
              ? // The frame hugs the stack of sheets, whatever is drawn on the front one.
                ({ '--bx': '26px', '--by': '-1px', '--bw': '92px', '--bh': '70px' } as CSSProperties)
              : drawn
              ? ({
                  '--cx': `${Math.round(drawn.centerX * 100)}%`,
                  '--bx': `${drawn.bounds.x}px`,
                  '--by': `${drawn.bounds.y}px`,
                  '--bw': `${drawn.bounds.width}px`,
                  '--bh': `${drawn.bounds.height}px`,
                } as CSSProperties)
              : ({ '--bx': '46px', '--by': '14px', '--bw': '52px', '--bh': '48px' } as CSSProperties)
          }
        >
          {kind === 'project' && <StackGlyph sheets={Math.min(3, Math.max(1, stack))} />}
          {drawn ? <StarterGlyph starter={drawn} /> : kind === 'folder' ? <FolderGlyph /> : kind === 'more' ? <MoreGlyph /> : kind === 'project' ? null : <SheetGlyph />}
          <SelectionChrome />
        </span>
        <span className="dc-starter-name">
          {edited && <span className="dc-desk-edited" aria-hidden="true" />}
          {name}
        </span>
        {meta && <span className="dc-desk-tile-meta">{meta}</span>}
      </button>
      {action && (
        <button type="button" className="dc-desk-tile-action" aria-label={action.label} title={action.label} onClick={action.run}>
          <Icon name={action.icon} size={12} />
        </button>
      )}
    </div>
  );
}

/** Whether the element has come within reach of the screen: once it has, it stays seen. */
function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (seen || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setSeen(true);
        observer.disconnect();
      },
      // A screen's height ahead, so a drawing is ready by the time it scrolls in.
      { rootMargin: '100% 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

/**
 * A project: its diagrams as a small stack of sheets, one to three deep, the newest drawn on the front
 * one (by the tile, over this). A project with nothing in it yet is one empty sheet.
 */
function StackGlyph({ sheets }: { sheets: number }) {
  return (
    <svg className="dc-starter-glyph dc-desk-stack" viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`} width={GLYPH_WIDTH} height={GLYPH_HEIGHT} aria-hidden="true" focusable="false">
      {sheets >= 3 && <rect className="dc-desk-stack-sheet" data-depth="2" x="34" y="3" width="84" height="62" rx="5" />}
      {sheets >= 2 && <rect className="dc-desk-stack-sheet" data-depth="1" x="30" y="7" width="84" height="62" rx="5" />}
      <rect className="dc-desk-stack-sheet" data-depth="0" x="26" y="11" width="84" height="62" rx="5" />
    </svg>
  );
}

/** A diagram with nothing on it yet, or one that couldn't be looked at: a page, folded at the corner. */
function SheetGlyph() {
  return (
    <svg className="dc-starter-glyph dc-desk-sheet" viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`} width={GLYPH_WIDTH} height={GLYPH_HEIGHT} aria-hidden="true" focusable="false">
      <path d="M52 14.5h30l10 10v37.5a2 2 0 0 1-2 2H54a2 2 0 0 1-2-2V16.5a2 2 0 0 1 2-2Z" />
      <path d="M82 14.5v8a2 2 0 0 0 2 2h8" />
    </svg>
  );
}

/** A project: the folder it is, with the shape of a few diagrams inside. */
function FolderGlyph() {
  return (
    <svg className="dc-starter-glyph dc-desk-folder" viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`} width={GLYPH_WIDTH} height={GLYPH_HEIGHT} aria-hidden="true" focusable="false">
      <path d="M46 20.5a2 2 0 0 1 2-2h14l5 5h29a2 2 0 0 1 2 2v34a2 2 0 0 1-2 2H48a2 2 0 0 1-2-2Z" />
      <rect className="dc-desk-folder-doc" x="55" y="33" width="12" height="8" rx="1" />
      <rect className="dc-desk-folder-doc" x="77" y="33" width="12" height="8" rx="1" />
      <rect className="dc-desk-folder-doc" x="66" y="47" width="12" height="8" rx="1" />
      <path className="dc-desk-folder-edge" d="M67 37h10M72 41v6" />
    </svg>
  );
}

/** The rest of a set: three sheets fanned, the way a stack of drawings looks from the side. */
function MoreGlyph() {
  return (
    <svg className="dc-starter-glyph dc-desk-more-glyph" viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`} width={GLYPH_WIDTH} height={GLYPH_HEIGHT} aria-hidden="true" focusable="false">
      <rect x="58" y="22" width="32" height="38" rx="2" transform="rotate(-8 74 41)" />
      <rect x="56" y="20" width="32" height="38" rx="2" transform="rotate(4 72 39)" />
      <rect x="54" y="18" width="32" height="38" rx="2" />
      <circle cx="63" cy="37" r="1.4" />
      <circle cx="70" cy="37" r="1.4" />
      <circle cx="77" cy="37" r="1.4" />
    </svg>
  );
}
