import { useMemo } from 'react';
import { headingsOf, type Placement } from '../../export/docs/markdown';
import { SegmentedControl } from '../common/SegmentedControl';
import { Icon } from '../common/Icon';
import type { DocsPublishing } from './useDocsPublishing';

function placementKey(placement: Placement): string {
  return placement.kind === 'end' ? 'end' : `line:${placement.line}`;
}

function relativeTime(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

type Tone = 'quiet' | 'good' | 'warn';

/**
 * Where the picture stands, in a word or two — the badge — and, only when something needs the
 * person's attention, one short line under it. The longer story lives in the badge's tooltip and
 * in the guide, not on the panel.
 */
function standing(docs: DocsPublishing): { tone: Tone; badge: string; detail?: string; note?: string } {
  if (docs.target.kind === 'bundle') {
    return {
      tone: 'quiet',
      badge: 'Snapshot',
      detail: 'A one-off copy. Download again to update it.',
      note: docs.draftOnDesktop ? 'Save this diagram to a file to publish the picture beside it and redraw it on every save.' : undefined,
    };
  }
  const picture = docs.picture;
  if (picture?.state === 'taken') {
    const whose = picture.why === 'foreign' ? 'wasn’t made by Draft Canvas' : 'is another diagram’s picture';
    return { tone: 'warn', badge: 'Name taken', note: `${picture.name} ${whose}, so it won’t be replaced. Rename the diagram, or move that file, to publish here.` };
  }
  if (docs.checking) return { tone: 'quiet', badge: 'Checking…' };
  if (picture?.state !== 'ours') return { tone: 'quiet', badge: 'Not published' };
  if (docs.current) {
    const when = relativeTime(picture.modifiedMs);
    return { tone: 'good', badge: 'Up to date', detail: when ? `Written ${when}` : undefined };
  }
  if (docs.target.dirty) return { tone: 'warn', badge: 'Unsaved changes', detail: 'Publishing saves the diagram first.' };
  // A changed choice (level, look, redraw) isn't the diagram going stale: it waits for Update.
  if (docs.unapplied) return { tone: 'warn', badge: 'Not applied', detail: 'Update the picture to apply your choices.' };
  return { tone: 'warn', badge: 'Out of date' };
}

export function ExportDocsPanel({ docs }: { docs: DocsPublishing }) {
  const said = standing(docs);
  const headings = docs.markdown ? headingsOf(docs.markdown.text) : [];
  const following = docs.target.kind === 'file' && docs.sync;
  return (
    <div className="dc-export-panel dc-docs-panel">
      <div className="dc-docs-head">
        <span className="dc-docs-chain" aria-label={`${docs.sourceName} draws ${docs.imageName}`}>
          <span className="dc-docs-file" title={docs.sourceName}>
            <Icon name="pencil" size={12} />
            <FileName name={docs.sourceName} />
          </span>
          <span className="dc-docs-arrow" aria-hidden="true" data-sync={following ? 'true' : undefined} />
          <span className="dc-docs-file" data-published={docs.picture?.state === 'ours' ? 'true' : undefined} title={docs.imageName}>
            <Icon name="image" size={12} />
            <FileName name={docs.imageName} />
          </span>
        </span>
      </div>
      {said.note && <p className="dc-docs-note" data-tone={said.tone === 'warn' ? 'warn' : undefined}>{said.note}</p>}
      {docs.orphans.length > 0 && (
        <p className="dc-docs-note">
          {docs.orphans.length === 1 ? `${docs.orphans[0]} shows a level that’s gone` : `${docs.orphans.length} pictures show levels that are gone`}, so saves leave{' '}
          {docs.orphans.length === 1 ? 'it' : 'them'} as {docs.orphans.length === 1 ? 'it was' : 'they were'}.
        </p>
      )}

      <div className="dc-export-form">
        {docs.levels.length > 1 && (
          <>
            <label className="dc-export-label" htmlFor="dc-docs-level">Level</label>
            <select id="dc-docs-level" className="dc-select" value={docs.viewKey} onChange={(event) => docs.setView(event.target.value)} disabled={docs.busy}>
              {docs.levels.map((level) => (
                <option key={level.path.join('/')} value={level.path.join('/')}>
                  {level.published ? `${level.label} · published` : level.label}
                </option>
              ))}
            </select>
          </>
        )}

        <span className="dc-export-label" aria-hidden="true">Look</span>
        <SegmentedControl
          name="docs-theme"
          legend="Look"
          value={docs.theme}
          onChange={docs.setTheme}
          disabled={docs.busy}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />

        <span className="dc-export-label dc-export-label-top" aria-hidden="true">Markdown</span>
        <div className="dc-docs-markdown">
          <div className="dc-docs-markdown-line">
            {/* Focusable: a long path scrolls, and a keyboard has to be able to scroll it too. */}
            {/* One Copy Markdown, in the footer: a second icon here was the same action under the same name. */}
            <code tabIndex={0} aria-label="Markdown for this picture">{docs.snippet}</code>
          </div>
          <p className="dc-docs-hint">
            {docs.markdown ? (
              <span title={docs.markdown.displayPath}>{docs.alreadyIn ? `Already in ${docs.markdown.name}` : `From ${docs.markdown.name}`}</span>
            ) : docs.target.kind === 'file' ? (
              <span>{docs.canCopy ? 'From the diagram’s folder' : docs.picture?.state === 'taken' ? 'Not available while the name is taken' : 'Publish first, then copy'}</span>
            ) : (
              <span>Put the diagrams folder next to your Markdown file</span>
            )}
            {docs.chooseMarkdown && (
              <button type="button" className="dc-link-button" onClick={() => void docs.chooseMarkdown?.()} disabled={docs.busy}>
                {docs.markdown ? 'Change' : 'Choose file…'}
              </button>
            )}
          </p>
        </div>

        {docs.markdown && !docs.alreadyIn && headings.length > 0 && (
          <>
            <label className="dc-export-label" htmlFor="dc-docs-section">Section</label>
            <select
              id="dc-docs-section"
              className="dc-select"
              value={placementKey(docs.placement)}
              disabled={docs.busy}
              onChange={(event) => {
                const value = event.target.value;
                docs.setPlacement(value === 'end' ? { kind: 'end' } : { kind: 'section', line: Number(value.slice(5)) });
              }}
            >
              {headings.map((heading) => (
                <option key={heading.line} value={`line:${heading.line}`}>
                  {heading.text || 'Untitled'}
                </option>
              ))}
              <option value="end">End of file</option>
            </select>
          </>
        )}

        {docs.target.kind === 'file' && (
          <>
            <span className="dc-export-label" aria-hidden="true">Updates</span>
            <label className="dc-check" title="Each save of the diagram, yours or an agent’s, redraws the picture. Markdown is never changed by this.">
              <input type="checkbox" checked={docs.sync} disabled={docs.busy} onChange={(event) => docs.setSync(event.target.checked)} />
              <span>Redraw on every save</span>
            </label>
          </>
        )}
      </div>

      {docs.justDone && (
        <p className="dc-docs-done">
          <Icon name="check" size={13} />
          <span>{docs.justDone}</span>
          {docs.reveal && (
            <button type="button" className="dc-link-button" onClick={() => void docs.reveal?.()}>
              {revealLabel()}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** The name with its extension kept whole: when space runs out, the stem gives way, not the type. */
function FileName({ name }: { name: string }) {
  const dot = name.lastIndexOf('.');
  return (
    <span className="dc-docs-file-name">
      <span className="dc-docs-file-base">{dot > 0 ? name.slice(0, dot) : name}</span>
      {dot > 0 && <span className="dc-docs-file-ext">{name.slice(dot)}</span>}
    </span>
  );
}

function revealLabel(): string {
  if (typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)) return 'Show in Finder';
  return 'Show in folder';
}

function cleanLine(line: string): { kind: 'heading' | 'text' | 'image' | 'blank'; text: string } {
  const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return { kind: 'heading', text: heading[1] ?? '' };
  // A picture already on the page (another level, another diagram) reads as a picture, not its alt
  // text, so the new one is seen landing beside it.
  const image = /^\s*!\[([^\]]*)\]\([^)]*\)\s*$/.exec(line);
  if (image) return { kind: 'image', text: image[1] || 'Image' };
  if (line.trim() === '') return { kind: 'blank', text: '' };
  return { kind: 'text', text: line.replace(/[*_`]/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').trim() };
}

/**
 * The picture where it will be read: a page of the Markdown file — its real lines around the spot,
 * once a file is chosen, or the outline of one — with the diagram in place. What Download or Add
 * produces is drawn by the same function as this.
 */
export function DocsPreview({ docs }: { docs: DocsPublishing }) {
  const preview = docs.preview;
  const said = standing(docs);
  const src = useMemo(
    () => (preview && preview !== 'missing' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.svg)}` : null),
    [preview],
  );
  const image = (
    <span className="dc-docs-figure" data-inserted={docs.excerpt?.added ? 'true' : undefined} data-fresh={docs.justDone ? 'true' : undefined}>
      {src ? <img src={src} alt={docs.title} draggable={false} /> : <Icon name="image" size={20} />}
    </span>
  );
  const lines = docs.excerpt?.lines;
  const at = lines?.findIndex((line) => line.inserted) ?? -1;
  return (
    <figure className="dc-docs-page" data-theme-look={docs.theme} aria-label={docs.markdown ? `${docs.markdown.name} with the diagram added` : 'How the diagram reads in Markdown'}>
      <div className="dc-docs-page-bar">
        <Icon name="file" size={12} />
        <span>{docs.markdown?.name ?? 'README.md'}</span>
      </div>
      <div className="dc-docs-page-body">
        {lines ? (
          <>
            {lines.slice(0, at).map((line, index) => <ExcerptLine key={`b${index}`} line={line.text} />)}
            {image}
            {lines.slice(at + 1).map((line, index) => <ExcerptLine key={`a${index}`} line={line.text} />)}
          </>
        ) : (
          <>
            <span className="dc-docs-heading">{docs.markdown?.name.replace(/\.(md|markdown|mdx)$/i, '') ?? 'Architecture'}</span>
            <span className="dc-docs-bar" style={{ width: '86%' }} />
            <span className="dc-docs-bar" style={{ width: '64%' }} />
            {image}
            <span className="dc-docs-bar" style={{ width: '78%' }} />
          </>
        )}
      </div>
      <figcaption className="dc-export-caption">
        <span className="dc-docs-caption-head">
          <span className="dc-export-filename" title={docs.imageName}>
            <span className="dc-export-filename-base">{docs.imageName.replace(/\.svg$/, '')}</span>
            <span className="dc-export-filename-ext">.svg</span>
          </span>
          <span className="dc-docs-badge" data-tone={said.tone} title={said.detail} role="status" aria-live="polite">
            {said.badge}
          </span>
        </span>
        <span className="dc-export-meta">
          {preview === 'missing'
            ? 'This level no longer exists'
            : preview
              ? `${preview.width} × ${preview.height} · picture only`
              : 'Drawing…'}
        </span>
      </figcaption>
    </figure>
  );
}

function ExcerptLine({ line }: { line: string }) {
  const clean = cleanLine(line);
  if (clean.kind === 'blank') return null;
  if (clean.kind === 'image') {
    return (
      <span className="dc-docs-image-line">
        <Icon name="image" size={11} />
        <span>{clean.text}</span>
      </span>
    );
  }
  return <span className={clean.kind === 'heading' ? 'dc-docs-heading' : 'dc-docs-text'}>{clean.text}</span>;
}
