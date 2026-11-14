import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DraftSummary } from '../../document/types';
import type { DocumentSession } from '../../store/useDocumentSession';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { relativeTime } from '../../lib/relativeTime';
import { worthBackingUp } from '../../storage/backupStatus';
import { warmModal } from '../common/modalLoader';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { LibraryBrand } from './LibraryBrand';
import { LocalNote } from './LocalNote';
import { WebHomeScene } from './WebHomeScene';
import { DeleteDialog, RenameDialog } from './DiagramDialogs';
import { DocumentPreview } from './DocumentPreview';
import { ProjectNameDialog } from './ProjectSidebar';
import type { LibraryView } from './libraryFilter';
import './home-shelf.css';

type HomeView = 'drafts' | 'recent' | 'projects';

/** The web welcome and returning Home use a browser sketchbook and compact gallery shelf.
 * Browser diagrams are local drafts; Recent orders them by their most recent edit. */
export function FirstRunHome({ session, notice, onImport, onBrowse }: {
  session: DocumentSession;
  /** Shown under the brand row — the old address's moved-house notice. */
  notice?: ReactNode;
  onImport: () => void;
  onBrowse: (view: LibraryView, search?: boolean) => void;
}) {
  const sheetRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const shelfRef = useRef<HTMLElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const importHintId = useId();
  const startHintId = useId();
  const [chosen, setChosen] = useState<HomeView | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<DraftSummary | null>(null);
  const [deleting, setDeleting] = useState<DraftSummary | null>(null);
  const [capacity, setCapacity] = useState(3);
  const hasDiagrams = session.library.length > 0;
  const sources: { id: HomeView; label: string }[] = [
    ...(hasDiagrams ? [{ id: 'drafts' as const, label: 'Drafts' }, { id: 'recent' as const, label: 'Recent' }] : []),
    { id: 'projects', label: 'Projects' },
  ];
  const active = sources.find((source) => source.id === chosen) ?? sources[0]!;
  const showTabs = sources.length > 1;
  const recent = useMemo(() => [...session.library].sort((a, b) => b.updatedAt - a.updatedAt), [session.library]);
  const total = active.id === 'projects' ? session.projects.length : session.library.length;
  const currentActions = useRef({ session, onBrowse, hasDiagrams });
  useLayoutEffect(() => { currentActions.current = { session, onBrowse, hasDiagrams }; });

  useLayoutEffect(() => {
    const shelf = shelfRef.current;
    if (!shelf || typeof ResizeObserver === 'undefined') return;
    const measure = () => setCapacity(Math.max(1, Math.min(5, Math.floor((shelf.clientWidth + 20) / 230))));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shelf);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || isImeKeyEvent(event)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      // Enter is deliberately not claimed here: with nothing focused it used to start a blank
      // canvas, so a stray press (a key left over from another window, a dismissed dialog) added an
      // "Untitled diagram". Quick Draft starts one on Enter when it has focus, like any button.
      if ((event.key === '/' || (event.key === 'f' && (event.metaKey || event.ctrlKey))) && currentActions.current.hasDiagrams) {
        event.preventDefault();
        currentActions.current.onBrowse({ kind: 'all' }, true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const focusRow = () => rowRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const next = sources[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      setChosen(next.id);
      rootRef.current?.querySelector<HTMLButtonElement>(`[data-home-source="${next.id}"]`)?.focus();
    } else if (event.key === 'ArrowDown') { event.preventDefault(); focusRow(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); sheetRef.current?.focus(); }
  };
  const onTileKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tiles = [...(rowRef.current?.querySelectorAll<HTMLButtonElement>('.dc-home-draft') ?? [])];
    const index = tiles.indexOf(event.currentTarget);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const next = tiles[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (next) { event.preventDefault(); next.focus(); }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      (rootRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]') ?? sheetRef.current)?.focus();
    }
  };

  return (
    <div className="dc-home dc-web-home" ref={rootRef}>
      <div className="dc-home-inner">
        <header className="dc-home-head">
          <LibraryBrand />
          {hasDiagrams && <Button variant="quiet" icon="search" title="Find a diagram" onClick={() => onBrowse({ kind: 'all' }, true)} />}
        </header>
        {notice}
        <WebHomeScene
          start={
            <button ref={sheetRef} type="button" className="dc-web-start" aria-label="Quick Draft" aria-describedby={startHintId}
              onClick={() => void session.newDocument()}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown') return;
                event.preventDefault();
                const tab = rootRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
                if (tab) tab.focus(); else focusRow();
              }}>
              <span className="dc-web-start-mark" aria-hidden="true"><Icon name="plus" size={28} /></span>
              <span className="dc-web-start-name">Quick Draft<Icon name="forward" size={18} /></span>
              <span id={startHintId} className="dc-web-start-hint">No title needed. Just begin.</span>
            </button>
          }
          example={<Button variant="quiet" icon="flow" onClick={() => void session.newDocument(undefined, 'example')}>Try an example</Button>}
          importFile={<Button variant="quiet" icon="upload" onClick={onImport} aria-describedby={importHintId}>Import a file</Button>}
        />
        <span id={importHintId} className="dc-sr-only">Opens a .draftcanvas, .json or secure .dcenc file, an editable PNG or SVG export, or a Mermaid flowchart.</span>
        <section className="dc-home-shelf" ref={shelfRef} aria-label="Your sketch shelf">
          <header className="dc-home-shelf-head">
            {showTabs && <div role="tablist" aria-label="Show">
              {sources.map((source, index) => <button key={source.id} type="button" role="tab" id={`dc-home-tab-${source.id}`} data-home-source={source.id}
                aria-selected={active.id === source.id} aria-controls="dc-home-shelf-row" tabIndex={active.id === source.id ? 0 : -1}
                onClick={() => setChosen(source.id)} onKeyDown={(event) => onTabKey(event, index)}>{source.label}</button>)}
            </div>}
            <div className="dc-home-shelf-actions">
              {active.id === 'projects' && total > 0 && <Button variant="quiet" icon="plus" onPointerEnter={warmModal} onFocus={warmModal} onClick={() => setCreating(true)}>New project</Button>}
              {total > 0 && <button type="button" className="dc-home-view-all" onClick={() => onBrowse({ kind: active.id === 'recent' ? 'recent' : 'all' })}>View all <span>{total}</span><Icon name="forward" size={13} /></button>}
            </div>
          </header>
          <div className="dc-home-shelf-row" id="dc-home-shelf-row" ref={rowRef} style={{ gridTemplateColumns: `repeat(${capacity}, minmax(0, 1fr))` }}
            role={showTabs ? 'tabpanel' : 'group'} aria-labelledby={showTabs ? `dc-home-tab-${active.id}` : undefined} aria-label={showTabs ? undefined : active.label}>
            {active.id === 'projects' ? session.projects.slice(0, capacity).map((project) => {
              const diagrams = recent.filter((entry) => entry.projectId === project.id);
              return <button type="button" className="dc-home-draft" key={project.id} aria-label={`Show the ${project.name} project`} onKeyDown={onTileKey} onClick={() => onBrowse({ kind: 'project', projectId: project.id })}>
                {diagrams[0] ? <DocumentPreview shape={diagrams[0].shape} /> : <span className="dc-gallery-preview"><Icon name="folder" size={38} /></span>}
                <span className="dc-home-draft-name">{project.name}</span><span className="dc-home-draft-meta">{diagrams.length ? `${diagrams.length} ${diagrams.length === 1 ? 'diagram' : 'diagrams'}` : 'No diagrams yet'}</span>
              </button>;
            }) : recent.slice(0, capacity).map((entry) => <div className="dc-home-card" key={entry.id}>
              <button type="button" className="dc-home-draft" aria-label={`Open ${entry.title}`} onKeyDown={onTileKey} onClick={() => void session.openDocument(entry.id)}>
                <DocumentPreview shape={entry.shape} paper /><span className="dc-home-draft-name">{entry.title}</span><span className="dc-home-draft-meta">{relativeTime(entry.updatedAt)}</span>
              </button>
              {/* Tucked into the paper's corner: there on hover or focus, always there on touch. */}
              <div className="dc-home-card-actions">
                <Button icon="pencil" variant="quiet" aria-label={`Rename ${entry.title}`} title="Rename" onPointerEnter={warmModal} onFocus={warmModal} onClick={() => setRenaming(entry)} />
                <Button icon="copy" variant="quiet" aria-label={`Duplicate ${entry.title}`} title="Duplicate" onClick={() => void session.duplicateDocument(entry.id)} />
                <Button icon="trash" variant="quiet" aria-label={`Delete ${entry.title}`} title="Delete" onPointerEnter={warmModal} onFocus={warmModal} onClick={() => setDeleting(entry)} />
              </div>
            </div>)}
            {active.id === 'projects' && session.projects.length === 0 && <div className="dc-home-project-welcome">
              <span className="dc-home-project-art" aria-hidden="true"><Icon name="folder" size={56} /></span>
              <div><h2>A home for related ideas.</h2><p>Keep diagrams together in a project.</p></div>
              <Button variant="quiet" icon="plus" onPointerEnter={warmModal} onFocus={warmModal} onClick={() => setCreating(true)}>New project</Button>
            </div>}
          </div>
        </section>
        {(!session.durable || hasDiagrams) && <div className={session.durable ? 'dc-home-status' : 'dc-home-warn'}><LocalNote durable={session.durable} repository={session.repository} backupWorthwhile={worthBackingUp(session.library)} /></div>}
      </div>
      {creating && <ProjectNameDialog title="New project" submitLabel="Create" submitIcon="plus" initialValue="" onClose={() => setCreating(false)}
        onSubmit={(name) => { void session.createProject(name); setCreating(false); }} />}
      {renaming && <RenameDialog entry={renaming} onClose={() => setRenaming(null)}
        onSubmit={(title) => { void session.renameDocument(renaming.id, title); setRenaming(null); }} />}
      {deleting && <DeleteDialog entry={deleting} onClose={() => setDeleting(null)}
        onConfirm={() => {
          const index = recent.findIndex((entry) => entry.id === deleting.id);
          setDeleting(null);
          // The trash button the dialog would return focus to is gone with its card, so land on
          // the card that took its place, or on Quick Draft when the shelf is now empty.
          void session.deleteDocument(deleting.id).then(() => requestAnimationFrame(() => {
            const tiles = rowRef.current?.querySelectorAll<HTMLButtonElement>('.dc-home-draft') ?? [];
            const next = tiles[Math.min(index, tiles.length - 1)] ?? sheetRef.current;
            if (next && document.activeElement === document.body) next.focus();
          }));
        }} />}
    </div>
  );
}
