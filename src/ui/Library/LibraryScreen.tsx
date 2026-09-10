import { useEffect, useRef, useState } from 'react';
import { readProjectFile } from '../../export/project';
import { looksLikeSecureExport, readSecureProjectFile } from '../../export/secureProject';
import type { DraftSummary } from '../../document/types';
import type { NormalizeResult } from '../../document/validate';
import { PRODUCT } from '../../product';
import { ARCHITECTURE_STARTERS } from '../../starters';
import { useUiStore } from '../../store/uiStore';
import type { DocumentSession } from '../../store/useDocumentSession';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { Modal } from '../common/Modal';
import { useTheme } from '../theme/useTheme';
import { Fingerprint } from './Fingerprint';
import { LocalNote } from './LocalNote';
import { MoveToProjectMenu } from './MoveToProjectMenu';
import { ProjectSidebar } from './ProjectSidebar';
import { thoughtForDay } from './draftThoughts';
import { headingFor, visibleCanvases, type LibrarySort } from './libraryFilter';

/**
 * The landing screen: what is stored in this browser, optionally grouped
 * into Projects.
 *
 * Deliberately still not a file manager. One flat, optional grouping — no
 * nested folders, no required setup before creating a canvas — plus local
 * search and sort, so it stays scannable at dozens or hundreds of diagrams.
 *
 * It is also the only page most people see before deciding what Draft Canvas
 * is, so the product introduces itself here — but by being itself, not by
 * describing itself: a fingerprint of each diagram's topology, one opinion
 * at the foot of the page. The list stays the point. Nothing here is a tour,
 * a card, or a banner.
 */
export function LibraryScreen({ session }: { session: DocumentSession }) {
  const notify = useUiStore((state) => state.notify);
  const setAboutOpen = useUiStore((state) => state.setAboutOpen);
  const updateReady = useUiStore((state) => state.updateReady);
  const searchQuery = useUiStore((state) => state.librarySearchQuery);
  const setSearchQuery = useUiStore((state) => state.setLibrarySearchQuery);
  const sort = useUiStore((state) => state.librarySort);
  const setSort = useUiStore((state) => state.setLibrarySort);
  const view = useUiStore((state) => state.libraryView);
  const setView = useUiStore((state) => state.setLibraryView);
  const moveMenuOpenFor = useUiStore((state) => state.moveMenuOpenFor);
  const setMoveMenuOpenFor = useUiStore((state) => state.setMoveMenuOpenFor);
  const { name: themeName, toggle: toggleTheme } = useTheme();
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<DraftSummary | null>(null);
  const [renaming, setRenaming] = useState<DraftSummary | null>(null);
  const [securePendingFile, setSecurePendingFile] = useState<File | null>(null);

  // A project can vanish out from under the current view (deleted from
  // another tab, or a stale selection after this session's own delete
  // already redirects) — fall back to the default view rather than showing
  // an empty list under a project name that no longer exists.
  useEffect(() => {
    if (view.kind === 'project' && !session.projects.some((project) => project.id === view.projectId)) {
      setView({ kind: 'recent' });
    }
  }, [session.projects, setView, view]);

  // `/` reaches the search box from anywhere on the page that isn't already
  // taking keys — the one shortcut this screen has, and the one every
  // developer tool teaches. Never while a dialog is up.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      searchInput.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useRelativeTimeTick();

  const searching = searchQuery.trim().length > 0;
  const canvases = visibleCanvases(session.library, session.projects, view, searchQuery, sort);
  const heading = headingFor(view, session.projects, searching);
  const empty = session.ready && session.library.length === 0;
  // A nav with nothing to navigate: no canvases and no projects means the
  // sidebar would be three views of the same empty list.
  const showSidebar = session.library.length > 0 || session.projects.length > 0;

  const finishImport = async (result: NormalizeResult) => {
    if (!result.ok) {
      notify(result.error, 'error');
      return;
    }
    if (result.repairs.length > 0) {
      notify(`Imported with repairs: ${result.repairs.join(' ')}`);
    }
    await session.adoptDocument(result.document);
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    if (looksLikeSecureExport(file)) {
      // Reading it needs a passphrase first — hand off to the prompt below
      // rather than reading (and failing) here.
      setSecurePendingFile(file);
      return;
    }
    await finishImport(await readProjectFile(file));
  };

  return (
    <div className="dc-library">
      <div className="dc-library-inner">
        <header className="dc-library-header">
        <div className="dc-brand">
            <h1>{PRODUCT.name}</h1>
            <span className="dc-badge-anchor">
              <button
                type="button"
                className="dc-brand-about"
                onClick={() => setAboutOpen(true)}
                aria-label="About Draft Canvas"
                title={updateReady ? 'About Draft Canvas — update ready' : 'About Draft Canvas'}
              >
                <Icon name="info" size={14} />
              </button>
              {updateReady && <span className="dc-update-dot" aria-hidden="true" />}
            </span>
            <button
              type="button"
              className="dc-brand-about"
              onClick={toggleTheme}
              aria-label={themeName === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={themeName === 'dark' ? 'Light theme' : 'Dark theme'}
            >
              <Icon name={themeName === 'dark' ? 'sun' : 'moon'} size={14} />
            </button>
          </div>
          <p className="dc-lede">{PRODUCT.tagline}</p>
          <p className="dc-lede-aside">{PRODUCT.aside}</p>
        </header>

        <div className="dc-library-toolbar">
          <label className="dc-library-search">
            <Icon name="search" size={14} />
            <input
              ref={searchInput}
              type="search"
              placeholder="Search diagrams…"
              aria-label="Search diagrams"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            {!searching && <kbd aria-hidden="true">/</kbd>}
          </label>
          <div className="dc-library-actions">
            <Button
              variant="quiet"
              icon="upload"
              onClick={() => fileInput.current?.click()}
              disabled={!session.ready}
            >
              Import
            </Button>
            <Button
              variant="solid"
              icon="plus"
              onClick={() => void session.newDocument()}
              disabled={!session.ready}
            >
              New canvas
            </Button>
          </div>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept=".draftcanvas,.json,application/json,.dcenc"
          hidden
          onChange={(event) => {
            void onImport(event.target.files?.[0]);
            event.target.value = '';
          }}
        />

        <div className="dc-library-body">
          {showSidebar && (
            <ProjectSidebar session={session} library={session.library} view={view} onViewChange={setView} />
          )}

          <section className="dc-library-list">
            <div className="dc-library-list-head">
              <div className="dc-library-list-head-left">
                <h2>{heading}</h2>
                <span className="dc-library-count" aria-live="polite">
                  {searching ? `${canvases.length} of ${session.library.length}` : ''}
                </span>
              </div>
              {!(view.kind === 'recent' && !searching) && (
                <select
                  className="dc-select dc-library-sort"
                  aria-label="Sort diagrams"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as LibrarySort)}
                >
                  <option value="updatedAt">Last edited</option>
                  <option value="createdAt">Created</option>
                  <option value="name">Name</option>
                </select>
              )}
            </div>

            {!session.ready && <p className="dc-muted dc-library-empty">Opening local storage…</p>}

            {empty && (
              <div className="dc-library-empty dc-library-welcome">
                <p>Nothing here yet.</p>
                <p className="dc-muted">Start blank, or with an architecture Draft Canvas already knows.</p>
                <div className="dc-library-starters" role="group" aria-label="Architecture starters">
                  {ARCHITECTURE_STARTERS.map((starter) => (
                    <button
                      key={starter.id}
                      type="button"
                      className="dc-library-starter"
                      aria-label={`Start from ${starter.name}`}
                      title={starter.description}
                      onClick={() => void session.newDocument(undefined, starter.id)}
                    >
                      {starter.name}
                    </button>
                  ))}
                </div>
                <p className="dc-muted">
                  Or import a <code>.draftcanvas</code> file you exported earlier.
                </p>
              </div>
            )}

            {session.ready && session.library.length > 0 && canvases.length === 0 && (
              <div className="dc-library-empty">
                {searching ? (
                  <>
                    <p>No diagrams match &ldquo;{searchQuery.trim()}&rdquo;.</p>
                    <Button variant="quiet" icon="close" onClick={() => setSearchQuery('')}>
                      Clear search
                    </Button>
                  </>
                ) : (
                  <p>Nothing here yet.</p>
                )}
              </div>
            )}

            <ul>
              {canvases.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="dc-library-item"
                    title={entry.title.length > 40 ? entry.title : undefined}
                    onClick={() => void session.openDocument(entry.id)}
                  >
                    <Fingerprint shape={entry.shape} />
                    <span className="dc-library-item-text">
                      <span className="dc-library-item-title">{entry.title}</span>
                      <span className="dc-library-item-meta">
                        {relativeTime(entry.updatedAt)}
                        <span className="dc-dot" />
                        {entry.nodeCount} {entry.nodeCount === 1 ? 'element' : 'elements'}
                        {entry.edgeCount > 0 && (
                          <>
                            <span className="dc-dot" />
                            {entry.edgeCount} {entry.edgeCount === 1 ? 'connection' : 'connections'}
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                  <div className="dc-library-item-actions">
                    <Button
                      icon="pencil"
                      variant="quiet"
                      aria-label={`Rename ${entry.title}`}
                      onClick={() => setRenaming(entry)}
                    />
                    <Button
                      icon="copy"
                      variant="quiet"
                      aria-label={`Duplicate ${entry.title}`}
                      onClick={() => void session.duplicateDocument(entry.id)}
                    />
                    <span className="dc-move-menu-anchor">
                      <Button
                        icon="folder"
                        variant="quiet"
                        aria-label={`Move ${entry.title} to a project`}
                        onClick={() => setMoveMenuOpenFor(moveMenuOpenFor === entry.id ? null : entry.id)}
                      />
                      {moveMenuOpenFor === entry.id && (
                        <MoveToProjectMenu
                          currentProjectId={entry.projectId}
                          projects={session.projects}
                          onMove={(projectId) => void session.moveDocumentToProject(entry.id, projectId)}
                          onClose={() => setMoveMenuOpenFor(null)}
                        />
                      )}
                    </span>
                    <Button
                      icon="trash"
                      variant="quiet"
                      aria-label={`Delete ${entry.title}`}
                      onClick={() => setConfirmDelete(entry)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {session.ready && (
          <footer className="dc-library-foot">
            <p className="dc-thought">
              <Icon name="pencil" size={13} />
              <span>{thoughtForDay()}</span>
            </p>
            <LocalNote durable={session.durable} repository={session.repository} />
          </footer>
        )}
      </div>

      {confirmDelete && (
        <Modal
          title="Delete this diagram?"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={() => {
                  void session.deleteDocument(confirmDelete.id);
                  setConfirmDelete(null);
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p>
            <strong>{confirmDelete.title}</strong> will be removed from this browser. This cannot be
            undone.
          </p>
          <p className="dc-muted">
            If you might want it later, open it first and export a <code>.draftcanvas</code> file.
          </p>
        </Modal>
      )}

      {renaming && (
        <RenameDialog
          entry={renaming}
          onClose={() => setRenaming(null)}
          onSubmit={(title) => {
            void session.renameDocument(renaming.id, title);
            setRenaming(null);
          }}
        />
      )}

      {securePendingFile && (
        <SecureImportPrompt
          file={securePendingFile}
          onCancel={() => setSecurePendingFile(null)}
          onSubmit={async (passphrase) => {
            const file = securePendingFile;
            setSecurePendingFile(null);
            await finishImport(await readSecureProjectFile(file, passphrase));
          }}
        />
      )}
    </div>
  );
}

/**
 * "2 minutes ago" is computed at render, so a list left on screen would say
 * "just now" forever. One re-render a minute keeps it honest — and none at
 * all while the tab is hidden, where nobody is reading it.
 */
function useRelativeTimeTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => setTick((tick) => tick + 1), 60_000);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        setTick((tick) => tick + 1);
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}

function SecureImportPrompt({
  file,
  onCancel,
  onSubmit,
}: {
  file: File;
  onCancel: () => void;
  onSubmit: (passphrase: string) => void | Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!passphrase || busy) return;
    setBusy(true);
    try {
      await onSubmit(passphrase);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Enter passphrase"
      width={420}
      onClose={onCancel}
      footer={
        <>
          <Button variant="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="solid" icon="upload" disabled={!passphrase || busy} onClick={() => void submit()}>
            Import
          </Button>
        </>
      }
    >
      <p className="dc-muted">
        <strong>{file.name}</strong> is a secure Draft Canvas export. Enter the passphrase it was
        exported with to open it.
      </p>
      <label className="dc-field">
        <span>Passphrase</span>
        <input
          autoFocus
          type="password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') void submit();
          }}
        />
      </label>
    </Modal>
  );
}

function RenameDialog({
  entry,
  onClose,
  onSubmit,
}: {
  entry: DraftSummary;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  const [value, setValue] = useState(entry.title);
  const submit = () => {
    const title = value.trim();
    if (title) onSubmit(title);
    else onClose();
  };

  return (
    <Modal
      title="Rename"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" icon="check" onClick={submit}>
            Rename
          </Button>
        </>
      }
    >
      <label className="dc-field">
        <span>Title</span>
        <input
          autoFocus
          value={value}
          maxLength={200}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
      </label>
    </Modal>
  );
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 1000],
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
];

function relativeTime(at: number): string {
  const delta = at - Date.now();
  const absolute = Math.abs(delta);
  if (absolute < 45_000) return 'just now';

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (let i = UNITS.length - 1; i >= 0; i -= 1) {
    const [unit, ms] = UNITS[i]!;
    if (absolute >= ms) return formatter.format(Math.round(delta / ms), unit);
  }
  return 'just now';
}
