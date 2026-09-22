import type { ReactNode } from 'react';
import { relativeTime } from '../../lib/relativeTime';
import { PRODUCT } from '../../product';
import { Button } from '../../ui/common/Button';
import { LibraryBrand } from '../../ui/Library/LibraryBrand';
import type { ProjectFile, RecentItem, RecoveryEntry } from '../api';
import { useDesktopController, useDesktopState } from '../useDesktop';
import './desktop.css';

/** How many recent items Home lists; the shell keeps a few more for the tray's menu. */
const RECENT_SHOWN = 8;

/**
 * Where the desktop app opens: a plain list of what is worth going back to, and the ways to start.
 * It knows only names and dates — it never reads a diagram to draw its row — so a folder of a
 * thousand of them opens as fast as one. The Library's classes and tokens, deliberately: it is the
 * same home for the same app, and the files are just on disk instead of in the browser.
 */
export function DesktopHome() {
  const { ready, project, recents, recovery } = useDesktopState();
  const controller = useDesktopController();

  const recentFiles = recents.filter((item) => item.kind === 'file').slice(0, RECENT_SHOWN);
  const recentProjects = recents.filter((item) => item.kind === 'project' && item.displayPath !== project?.info.displayPath).slice(0, 3);
  const nothing = ready && recovery.length === 0 && !project && recents.length === 0;

  return (
    <div className="dc-library">
      <main className="dc-library-inner">
        <header className="dc-library-header">
          <LibraryBrand />
          <p className="dc-lede">{PRODUCT.tagline}</p>
        </header>

        <div className="dc-library-toolbar">
          <div className="dc-library-actions">
            <Button variant="quiet" icon="folder" onClick={() => void controller.pickProject()}>
              Open project…
            </Button>
            <Button variant="quiet" icon="upload" onClick={() => void controller.openFile()}>
              Open file…
            </Button>
            <Button variant="quiet" icon="plus" onClick={() => void controller.newCanvas()}>
              New canvas…
            </Button>
            <Button variant="solid" icon="plus" onClick={() => void controller.newQuickDraft()}>
              New Quick Draft
            </Button>
          </div>
        </div>

        <div className="dc-library-body">
          <section className="dc-library-list">
            {nothing && (
              <div className="dc-library-empty dc-library-welcome">
                <p>Nothing open.</p>
                <p className="dc-muted">
                  A Quick Draft starts drawing at once and keeps your work until you decide where it lives. A project is any
                  folder: open one to see the diagrams in it.
                </p>
              </div>
            )}

            {recovery.length > 0 && (
              <>
                <ListHead title="Unsaved" />
                <ul>
                  {recovery.map((entry) => (
                    <DraftRow key={entry.id} entry={entry} />
                  ))}
                </ul>
              </>
            )}

            {project && (
              <>
                <ListHead
                  title={project.info.name}
                  note={project.info.displayPath}
                  action={
                    <>
                      <Button variant="quiet" onClick={() => void controller.refreshProject()}>
                        Refresh
                      </Button>
                      <Button variant="quiet" onClick={() => controller.closeProject()}>
                        Close project
                      </Button>
                    </>
                  }
                />
                {project.loading && <p className="dc-muted dc-library-empty">Looking…</p>}
                {!project.loading && project.files.length === 0 && (
                  <div className="dc-library-empty">
                    <p>No diagrams in this project yet.</p>
                    <p className="dc-muted">Files ending in .draftcanvas show up here, subfolders included.</p>
                  </div>
                )}
                <ProjectFiles files={project.files} />
                {project.truncated && (
                  <p className="dc-muted dc-library-empty">
                    This folder holds more than Draft Canvas lists. Open a subfolder to see the rest.
                  </p>
                )}
              </>
            )}

            {(recentFiles.length > 0 || recentProjects.length > 0) && (
              <>
                <ListHead
                  title="Recent"
                  action={
                    <Button variant="quiet" onClick={() => void controller.clearRecents()}>
                      Clear
                    </Button>
                  }
                />
                <ul>
                  {recentProjects.map((item) => (
                    <RecentRow key={item.handle} item={item} onOpen={() => void controller.openProject(item.handle)} />
                  ))}
                  {recentFiles.map((item) => (
                    <RecentRow key={item.handle} item={item} onOpen={() => void controller.openHandle(item.handle)} />
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function ListHead({ title, note, action }: { title: string; note?: string; action?: ReactNode }) {
  return (
    <div className="dc-library-list-head">
      <div className="dc-library-list-head-left">
        <h2>{title}</h2>
        {note && <span className="dc-library-count">{note}</span>}
      </div>
      {action && <div className="dc-library-item-actions">{action}</div>}
    </div>
  );
}

function DraftRow({ entry }: { entry: RecoveryEntry }) {
  const controller = useDesktopController();
  const from = entry.origin.kind === 'file' ? 'Unsaved changes' : 'Not saved yet';
  return (
    <li>
      <button type="button" className="dc-library-item" onClick={() => void controller.recover(entry.id)}>
        <span className="dc-library-item-text">
          <span className="dc-library-item-title">{entry.origin.kind === 'file' ? entry.origin.name : entry.title}</span>
          <span className="dc-library-item-meta">
            {from} · {relativeTime(entry.updatedAt)}
          </span>
        </span>
      </button>
      <div className="dc-library-item-actions">
        <Button
          icon="trash"
          variant="quiet"
          aria-label={`Discard ${entry.title}`}
          title="Discard"
          onClick={() => void controller.discardRecovery(entry.id)}
        />
      </div>
    </li>
  );
}

function ProjectFiles({ files }: { files: ProjectFile[] }) {
  const controller = useDesktopController();
  return (
    <ul>
      {files.map((file) => {
        const folder = file.relPath.includes('/') ? file.relPath.slice(0, file.relPath.lastIndexOf('/')) : '';
        return (
          <li key={file.relPath}>
            <button type="button" className="dc-library-item" title={file.relPath} onClick={() => void controller.openProjectFile(file.relPath)}>
              <span className="dc-library-item-text">
                <span className="dc-library-item-title">{file.name}</span>
                <span className="dc-library-item-meta">
                  {folder ? `${folder} · ` : ''}
                  {relativeTime(file.mtimeMs)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function RecentRow({ item, onOpen }: { item: RecentItem; onOpen: () => void }) {
  const controller = useDesktopController();
  return (
    <li>
      <button type="button" className="dc-library-item" title={item.displayPath} onClick={onOpen}>
        <span className="dc-library-item-text">
          <span className="dc-library-item-title">{item.name}</span>
          <span className="dc-library-item-meta">
            {item.kind === 'project' ? 'Folder' : item.displayPath} · {relativeTime(item.lastOpenedMs)}
          </span>
        </span>
      </button>
      <div className="dc-library-item-actions">
        <Button
          icon="close"
          variant="quiet"
          aria-label={`Remove ${item.name} from Recent`}
          title="Remove from Recent"
          onClick={() => void controller.forgetRecent(item.handle)}
        />
      </div>
    </li>
  );
}
