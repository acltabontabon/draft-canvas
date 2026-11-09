import { useMemo } from 'react';
import { headingsOf, type Placement } from '../../export/docs/markdown';
import { hostKind } from '../../host/hostInfo';
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

/** The one sentence that says what this picture is: linked, a snapshot, current or not. */
function relationship(docs: DocsPublishing): { tone: 'quiet' | 'good' | 'warn'; text: string } {
  if (docs.target.kind === 'bundle') {
    return { tone: 'quiet', text: __DESKTOP__ && hostKind() === 'desktop' ? 'A snapshot. Save the diagram to a file to publish it beside the file and keep it updated.' : 'A snapshot of this diagram, with its editable source beside it.' };
  }
  if (docs.loading && !docs.status) return { tone: 'quiet', text: 'Looking beside the diagram…' };
  const state = docs.status?.state ?? 'none';
  if (state === 'foreign') return { tone: 'warn', text: `${docs.imageName} already exists beside the diagram and wasn’t made by Draft Canvas. It won’t be replaced; rename one of them to publish.` };
  if (state === 'none') return { tone: 'quiet', text: docs.sync ? 'Not published yet. Once it is, every save redraws the picture.' : 'Not published yet. It will stay a snapshot until you update it here.' };
  if (docs.current) {
    const when = relativeTime(docs.status?.modifiedMs);
    return { tone: 'good', text: docs.sync ? `Up to date${when ? `, written ${when}` : ''}. Every save redraws it.` : `Up to date${when ? `, written ${when}` : ''}. A snapshot: it changes only when you update it here.` };
  }
  if (docs.target.dirty) return { tone: 'warn', text: 'Unsaved changes. Publishing saves the diagram first, so the picture matches its file.' };
  return { tone: 'warn', text: 'The published picture differs from this diagram or these choices. Updating it keeps the Markdown as it is.' };
}

export function ExportDocsPanel({ docs, onCopy }: { docs: DocsPublishing; onCopy: () => void }) {
  const said = relationship(docs);
  const headings = docs.markdown ? headingsOf(docs.markdown.text) : [];
  return (
    <div className="dc-export-panel dc-docs-panel">
      <div className="dc-docs-link" data-tone={said.tone} aria-live="polite">
        <div className="dc-docs-chain">
          <span className="dc-docs-file" title={docs.sourceName}>
            <Icon name="pencil" size={12} />
            <FileName name={docs.sourceName} />
          </span>
          <span className="dc-docs-arrow" aria-hidden="true" data-sync={docs.target.kind === 'file' && docs.sync ? 'true' : undefined} />
          <span className="dc-docs-file" data-published={docs.status?.state === 'ours' ? 'true' : undefined} title={docs.imageName}>
            <Icon name="image" size={12} />
            <FileName name={docs.imageName} />
          </span>
        </div>
        <span className="dc-sr-only">: </span>
        <p className="dc-docs-relationship">{said.text}</p>
      </div>

      <div className="dc-export-row">
        {docs.levels.length > 1 && (
          <label className="dc-export-field">
            <span>Level</span>
            <select className="dc-select" value={docs.viewKey} onChange={(event) => docs.setView(event.target.value)} disabled={docs.busy}>
              {docs.levels.map((level) => (
                <option key={level.path.join('/')} value={level.path.join('/')}>
                  {level.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="dc-export-field">
          <span aria-hidden="true">Look</span>
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
        </span>
      </div>
      {docs.lostView && <p className="dc-docs-note" data-tone="warn">The level the published picture showed is gone. Choose the level to show instead.</p>}

      {docs.target.kind === 'file' && (
        <label className="dc-check" title="After each save of the diagram — by you or an agent — the picture beside it is drawn again. Markdown files are never changed by this.">
          <input type="checkbox" checked={docs.sync} disabled={docs.busy} onChange={(event) => docs.setSync(event.target.checked)} />
          <span>
            Keep {docs.imageName} updated
            <span className="dc-muted"> on every save</span>
          </span>
        </label>
      )}

      <div className="dc-docs-markdown">
        <div className="dc-docs-markdown-line">
          <code aria-label="Markdown for this picture">{docs.snippet}</code>
          <button type="button" className="dc-docs-copy" onClick={onCopy} aria-label="Copy Markdown" title="Copy Markdown">
            <Icon name="copy" size={13} />
          </button>
        </div>
        <p className="dc-docs-note">
          {docs.markdown ? (
            <>
              From <strong>{docs.markdown.name}</strong> <span className="dc-muted">{docs.markdown.displayPath}</span>.{' '}
              {docs.alreadyIn && <>It already shows this picture, so nothing will be added. </>}
            </>
          ) : docs.target.kind === 'file' ? (
            <>Path from a Markdown file beside {docs.sourceName}. </>
          ) : (
            <>Unzip the download next to your Markdown file: it holds <code>diagrams/{docs.imageName}</code> and its editable <code>{docs.sourceName}</code>. </>
          )}
          {docs.chooseMarkdown && (
            <button type="button" className="dc-link-button" onClick={() => void docs.chooseMarkdown?.()} disabled={docs.busy}>
              {docs.markdown ? 'Choose another…' : 'Choose the Markdown file…'}
            </button>
          )}
        </p>
        {docs.markdown && !docs.alreadyIn && (
          <label className="dc-export-field">
            <span>Place it</span>
            <select
              className="dc-select dc-docs-place"
              value={placementKey(docs.placement)}
              disabled={docs.busy}
              onChange={(event) => {
                const value = event.target.value;
                docs.setPlacement(value === 'end' ? { kind: 'end' } : { kind: 'section', line: Number(value.slice(5)) });
              }}
            >
              {headings.map((heading) => (
                <option key={heading.line} value={`line:${heading.line}`}>
                  {`End of “${heading.text || 'Untitled'}”`}
                </option>
              ))}
              <option value="end">End of {docs.markdown.name}</option>
            </select>
          </label>
        )}
      </div>

      {docs.justDone && (
        <p className="dc-docs-done" role="status">
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

function cleanLine(line: string): { kind: 'heading' | 'text' | 'blank'; text: string } {
  const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return { kind: 'heading', text: heading[1] ?? '' };
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
        <span className="dc-export-filename" title={docs.imageName}>
          <span className="dc-export-filename-base">{docs.imageName.replace(/\.svg$/, '')}</span>
          <span className="dc-export-filename-ext">.svg</span>
        </span>
        <span className="dc-export-meta">
          {preview === 'missing'
            ? 'This level no longer exists'
            : preview
              ? `${preview.width} × ${preview.height} · picture only, no diagram inside`
              : 'Drawing…'}
        </span>
      </figcaption>
    </figure>
  );
}

function ExcerptLine({ line }: { line: string }) {
  const clean = cleanLine(line);
  if (clean.kind === 'blank') return null;
  return <span className={clean.kind === 'heading' ? 'dc-docs-heading' : 'dc-docs-text'}>{clean.text}</span>;
}
