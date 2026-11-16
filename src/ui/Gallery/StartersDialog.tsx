import { useEffect, useMemo, useState } from 'react';
import { isCanvasEmpty } from '../../document/operations';
import type { DraftDocument } from '../../document/types';
import { renderSvgText } from '../../export/image';
import { GALLERY_CATEGORIES, GALLERY_PAGE, matchesQuery, starterFile, type GalleryCategory, type GalleryStarter } from '../../gallery';
import { openLink } from '../../host/openLink';
import { relativeTime } from '../../lib/relativeTime';
import { useEditorStore } from '../../store/editorStore';
import { useGalleryStore } from '../../store/galleryStore';
import { useUiStore } from '../../store/uiStore';
import { useTheme } from '../../theme/useTheme';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { Modal } from '../common/Modal';
import { InkedWords } from '../Library/InkedWords';
import { StarterTile, type StarterTileData } from '../Library/StarterTile';
import './starters.css';

const REPOSITORY_LABEL = GALLERY_PAGE.replace('https://', '');

/** What a starter's tile says when it can't be chosen. */
function tileOf(starter: GalleryStarter): StarterTileData {
  const unavailable =
    starter.availability === 'needs-update' ? 'Needs a newer Draft Canvas' : starter.availability === 'missing' ? 'Not downloaded — refresh to try again' : undefined;
  return { ...starter, ...(unavailable ? { unavailable } : {}) };
}

function updatedOn(date: string): string {
  if (!date) return '';
  const at = new Date(`${date}T00:00:00`);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The Starters dialog: the public starters gallery, browsed by kind or searched, each starter
 * previewed as the app will draw it, then added to the canvas or opened as a canvas of its own.
 * Before the person has chosen to load starters it is a short explanation and a choice, and nothing
 * is read from the network.
 */
export function StartersDialog({ onAdd }: { onAdd: (id: string) => void }) {
  const dialog = useGalleryStore((state) => state.dialog);
  if (!dialog.open) return null;
  return <StartersDialogBody focus={dialog.focus} onAdd={onAdd} />;
}

function StartersDialogBody({ focus, onAdd }: { focus?: string; onAdd: (id: string) => void }) {
  const enabled = useGalleryStore((state) => state.enabled);
  const snapshot = useGalleryStore((state) => state.snapshot);
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  // Browsing state survives a look at one starter and the way back.
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<GalleryCategory | 'all'>('all');
  const close = () => useGalleryStore.getState().closeDialog();
  const starter = selected ? snapshot?.starters.find((s) => s.id === selected) : undefined;

  return (
    <Modal
      title="Starters"
      width={920}
      className="dc-starters"
      onClose={close}
      {...(starter ? { onBack: () => setSelected(null), backLabel: 'Back to all starters' } : {})}
      footer={enabled ? <GalleryFooter /> : undefined}
    >
      {!enabled ? (
        <Consent />
      ) : starter ? (
        <Detail starter={starter} onAdd={onAdd} onDone={close} />
      ) : (
        <Browse query={query} onQuery={setQuery} category={category} onCategory={setCategory} onSelect={setSelected} />
      )}
    </Modal>
  );
}

/** A fanned stack of sheets: what's on the other side of "Load starters". */
function SheetStack() {
  return (
    <div className="dc-starters-sheets" aria-hidden="true">
      <span />
      <span />
      <span>
        <svg viewBox="0 0 120 76">
          <rect x="12" y="14" width="30" height="16" rx="3" />
          <rect x="78" y="14" width="30" height="16" rx="3" />
          <rect x="45" y="48" width="30" height="16" rx="3" />
          <path d="M42 22 H78 M60 30 V48" />
        </svg>
      </span>
    </div>
  );
}

function Consent() {
  const refreshing = useGalleryStore((state) => state.status === 'refreshing');
  const failure = useGalleryStore((state) => state.failure);
  return (
    <div className="dc-starters-consent">
      <SheetStack />
      <h3 className="dc-starters-display">
        Borrow a <em><InkedWords>starting point.</InkedWords></em>
      </h3>
      <p className="dc-starters-consent-lead">
        Monoliths, microservices, sagas and data pipelines, carefully drawn and kept in a public
        repository, so they get better between releases.
      </p>
      <ul className="dc-starters-promises">
        <li><Icon name="lock" size={13} /><span>Loading reads <strong>{REPOSITORY_LABEL}</strong> from GitHub. Nothing about your diagrams is sent.</span></li>
        <li><Icon name="pencil" size={13} /><span>A starter you add is an ordinary copy, yours to change.</span></li>
        <li><Icon name="refresh" size={13} /><span>You’ll see when a starter improves. Nothing changes unless you ask.</span></li>
      </ul>
      {failure && !refreshing && <p className="dc-starters-warning" role="alert">Couldn’t reach GitHub. Check your connection and try again.</p>}
      <div className="dc-starters-consent-actions">
        <Button variant="solid" icon="upload" disabled={refreshing} onClick={() => void useGalleryStore.getState().enable()}>
          {refreshing ? 'Loading starters…' : 'Load starters'}
        </Button>
        <Button variant="quiet" icon="github" onClick={() => openLink(GALLERY_PAGE)}>See them on GitHub</Button>
      </div>
    </div>
  );
}

function StatusLine() {
  const status = useGalleryStore((state) => state.status);
  const failure = useGalleryStore((state) => state.failure);
  const fetchedAt = useGalleryStore((state) => state.snapshot?.fetchedAt);
  const refreshing = status === 'refreshing';
  let text: string;
  if (refreshing) text = 'Checking for updates…';
  else if (failure === 'newer') text = 'Update Draft Canvas to see the latest';
  else if (failure && fetchedAt) text = `Offline · your copy from ${relativeTime(fetchedAt)}`;
  else if (fetchedAt) text = `Checked ${relativeTime(fetchedAt)}`;
  else text = '';
  return (
    <div className="dc-starters-status" data-failure={failure && !refreshing ? 'true' : undefined}>
      <span role="status" aria-live="polite">{text}</span>
      <Button
        variant="quiet"
        icon="refresh"
        aria-label="Check for new starters"
        data-spinning={refreshing ? 'true' : undefined}
        disabled={refreshing}
        onClick={() => void useGalleryStore.getState().refresh()}
      />
    </div>
  );
}

function Browse({
  query,
  onQuery,
  category,
  onCategory,
  onSelect,
}: {
  query: string;
  onQuery: (query: string) => void;
  category: GalleryCategory | 'all';
  onCategory: (category: GalleryCategory | 'all') => void;
  onSelect: (id: string) => void;
}) {
  const snapshot = useGalleryStore((state) => state.snapshot);
  const status = useGalleryStore((state) => state.status);
  const failure = useGalleryStore((state) => state.failure);
  const all = useMemo(() => snapshot?.starters ?? [], [snapshot]);
  const matching = useMemo(() => all.filter((s) => matchesQuery(s, query)), [all, query]);
  const shown = category === 'all' ? matching : matching.filter((s) => s.category === category);
  const changed = all.filter((s) => s.mark);
  const categories = GALLERY_CATEGORIES.filter((c) => all.some((s) => s.category === c.id));

  if (!snapshot) {
    const busy = status !== 'idle';
    return (
      <div className="dc-starters-empty" role="status">
        {busy ? (
          <>
            <div className="dc-starters-skeleton" aria-hidden="true">
              {Array.from({ length: 4 }, (_, i) => <span key={i} style={{ animationDelay: `${i * 120}ms` }} />)}
            </div>
            <p>Fetching starters from GitHub…</p>
          </>
        ) : (
          <>
            <SheetStack />
            <p>{failure === 'newer' ? 'These starters need a newer Draft Canvas.' : 'Couldn’t reach GitHub. Check your connection and try again.'}</p>
            <Button variant="ghost" icon="refresh" onClick={() => void useGalleryStore.getState().refresh()}>Try again</Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="dc-starters-browse">
      <header className="dc-starters-head">
        <div>
          <h3 className="dc-starters-display">
            Borrow a <em>starting point.</em>
          </h3>
          <p className="dc-starters-sub">
            {changed.length > 0 ? (
              <span className="dc-starters-changed">
                <span className="dc-starters-dot" aria-hidden="true" />
                {changed.length === 1 ? `${changed[0]!.name} is ${changed[0]!.mark === 'new' ? 'new' : 'updated'}` : `${changed.length} starters are new or updated`}
              </span>
            ) : (
              'Pick one to preview it. Whatever you add is yours to change.'
            )}
          </p>
        </div>
        <StatusLine />
      </header>

      <div className="dc-starters-toolbar">
        <div className="dc-starters-chips" role="radiogroup" aria-label="Kind of starter">
          {[{ id: 'all' as const, label: 'All' }, ...categories].map((c) => {
            const count = c.id === 'all' ? matching.length : matching.filter((s) => s.category === c.id).length;
            return (
              <button key={c.id} type="button" role="radio" aria-checked={category === c.id} className="dc-starters-chip" onClick={() => onCategory(c.id)}>
                {c.label}
                <span className="dc-starters-chip-count">{count}</span>
              </button>
            );
          })}
        </div>
        <label className="dc-starters-search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Search starters" aria-label="Search starters" value={query} onChange={(event) => onQuery(event.target.value)} />
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="dc-starters-none">
          Nothing matches “{query}”.{' '}
          <button type="button" className="dc-starters-link" onClick={() => { onQuery(''); onCategory('all'); }}>Show every starter</button>
        </p>
      ) : (
        GALLERY_CATEGORIES.map(({ id, label }) => {
          const inCategory = shown.filter((s) => s.category === id);
          if (inCategory.length === 0) return null;
          return (
            <section key={id} className="dc-starters-section" aria-label={label}>
              {category === 'all' && <h4 className="dc-starters-section-title">{label}</h4>}
              <div className="dc-starters-grid">
                {inCategory.map((starter, index) => (
                  <StarterTile key={starter.id} starter={tileOf(starter)} index={index} describe onStart={onSelect} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

/** The starter drawn by the app's own exporter, in the current palette — exactly what will land. */
function Preview({ file, name }: { file: DraftDocument | null | undefined; name: string }) {
  const { name: theme } = useTheme();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    let live = true;
    let made: string | null = null;
    void renderSvgText(file, { theme, padding: 32, openPoints: false, transparent: true })
      .then((svg) => {
        if (!live) return;
        made = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        setUrl(made);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [file, theme]);
  return (
    <div className="dc-starters-preview" data-ready={url ? 'true' : undefined}>
      {url ? <img src={url} alt={`The ${name} starter`} /> : <span className="dc-starters-preview-wait" aria-hidden="true" />}
    </div>
  );
}

function Detail({ starter, onAdd, onDone }: { starter: GalleryStarter; onAdd: (id: string) => void; onDone: () => void }) {
  const canvasEmpty = useEditorStore((state) => isCanvasEmpty(state.document));
  const readOnly = useUiStore((state) => Boolean(state.readOnly));
  const [file, setFile] = useState<DraftDocument | null | undefined>(undefined);
  // Opening a starter marks it seen; what it was marked as stays on screen while it's looked at.
  const [mark] = useState(starter.mark);

  useEffect(() => {
    let live = true;
    useGalleryStore.getState().markSeen(starter);
    void (starter.availability === 'ready' ? starterFile(starter) : Promise.resolve(null)).then((loaded) => {
      if (live) setFile(loaded);
    });
    return () => {
      live = false;
    };
    // The version, not the object: a refresh that changes nothing keeps the same preview.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [starter.id, starter.sha256]);

  const category = GALLERY_CATEGORIES.find((c) => c.id === starter.category)?.label;
  const updated = updatedOn(starter.updated);
  const ready = starter.availability === 'ready' && !!file;
  // Onto a blank canvas, adding is the obvious move; onto a drawing, a canvas of its own is.
  const addFirst = canvasEmpty && !readOnly;
  // The palette's own command (`EditorScreen`), so adding from here frames the result the same way.
  const add = () => {
    onDone();
    onAdd(starter.id);
  };
  const open = async () => {
    if (await useGalleryStore.getState().openAsCanvas(starter.id)) onDone();
  };

  const flows = file?.flows ?? [];
  const hasGuide = starter.useWhen.length > 0 || starter.watchOutFor.length > 0;

  // A plate and its label, the same height side by side: the title card's heading meets the top of
  // the drawing and its buttons meet the bottom, with the flows it can present between. The guide
  // below keeps the same split, so one vertical line runs through the whole page.
  return (
    <article className="dc-starters-detail">
      <div className="dc-starters-hero">
        <Preview file={file} name={starter.name} />

        <div className="dc-starters-title">
          <div className="dc-starters-heading">
            <p className="dc-starters-kicker">
              <span>{category}</span>
              {mark && <span className="dc-starter-mark" data-mark={mark}>{mark === 'new' ? 'New' : 'Updated'}</span>}
            </p>
            <h3 className="dc-starters-name">{starter.name}</h3>
            <p className="dc-starters-summary">{starter.summary}</p>
            {starter.availability === 'needs-update' && <p className="dc-starters-warning">This starter needs a newer version of Draft Canvas.</p>}
            {starter.availability === 'missing' && <p className="dc-starters-warning">This starter didn’t download. Check for new starters to try again.</p>}
          </div>

          {/* Always present, so the buttons keep to the foot of the card when there are no flows. */}
          <div className="dc-starters-card-middle">
            {flows.length > 0 && (
              <section className="dc-starters-notes" data-tone="flow">
                <h4>Flows to present</h4>
                <ul>
                  {flows.map((flow) => (
                    <li key={flow.id}><Icon name="play" size={10} />{flow.title}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <div className="dc-starters-actions">
            {!readOnly && (
              <Button variant={addFirst ? 'solid' : 'ghost'} icon="plus" disabled={!ready} onClick={add}>
                Add to canvas
              </Button>
            )}
            <Button variant={addFirst ? 'ghost' : 'solid'} icon="file" disabled={!ready} onClick={() => void open()}>
              Open as new diagram
            </Button>
          </div>
          <p className="dc-starters-meta">
            {updated && <span>Updated {updated}</span>}
            <button type="button" className="dc-starters-link" onClick={() => openLink(`${GALLERY_PAGE}/tree/main/${starter.path.replace(/\/[^/]+$/, '')}`)}>
              Source <Icon name="external" size={11} />
            </button>
          </p>
        </div>
      </div>

      {hasGuide && (
        <div className="dc-starters-guide">
          {starter.useWhen.length > 0 && (
            <section className="dc-starters-notes" data-tone="use">
              <h4>Use it when</h4>
              <ul>{starter.useWhen.map((line) => <li key={line}>{line}</li>)}</ul>
            </section>
          )}
          {starter.watchOutFor.length > 0 && (
            <section className="dc-starters-notes" data-tone="watch">
              <h4>Watch out for</h4>
              <ul>{starter.watchOutFor.map((line) => <li key={line}>{line}</li>)}</ul>
            </section>
          )}
        </div>
      )}
    </article>
  );
}

function GalleryFooter() {
  return (
    <div className="dc-starters-footer">
      <span>
        From the public starters gallery,{' '}
        <button type="button" className="dc-starters-link" onClick={() => openLink(GALLERY_PAGE)}>
          {REPOSITORY_LABEL}
        </button>
      </span>
      <button type="button" className="dc-starters-link" onClick={() => void useGalleryStore.getState().disable()}>
        Stop loading starters
      </button>
    </div>
  );
}
