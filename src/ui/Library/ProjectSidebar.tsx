import { useMemo, useState } from 'react';
import type { DraftSummary, Project } from '../../document/types';
import type { DocumentSession } from '../../store/useDocumentSession';
import type { LibraryView } from './libraryFilter';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { Modal } from '../common/Modal';

interface ProjectSidebarProps {
  session: DocumentSession;
  library: DraftSummary[];
  view: LibraryView;
  onViewChange: (view: LibraryView) => void;
}

/**
 * The homepage's nav: the two full-library shortcuts ("Recently edited",
 * "All diagrams"), "Unorganized", and the flat list of Projects. One level
 * of grouping, no nesting — see `document/types.ts`'s `Project` doc comment.
 */
export function ProjectSidebar({ session, library, view, onViewChange }: ProjectSidebarProps) {
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  // One pass over the library instead of one `.filter()` per project — the per-project counts a
  // sidebar with dozens of projects would otherwise recompute in full, once each, on every render.
  const { unorganizedCount, countByProject } = useMemo(() => {
    let unorganized = 0;
    const byProject = new Map<string, number>();
    for (const entry of library) {
      if (entry.projectId) byProject.set(entry.projectId, (byProject.get(entry.projectId) ?? 0) + 1);
      else unorganized += 1;
    }
    return { unorganizedCount: unorganized, countByProject: byProject };
  }, [library]);
  const projectsSorted = [...session.projects].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <nav className="dc-library-sidebar" aria-label="Diagram views">
      <button
        type="button"
        className="dc-sidebar-row"
        data-active={view.kind === 'recent' ? 'true' : undefined}
        onClick={() => onViewChange({ kind: 'recent' })}
      >
        Recently edited
      </button>
      <button
        type="button"
        className="dc-sidebar-row"
        data-active={view.kind === 'all' ? 'true' : undefined}
        onClick={() => onViewChange({ kind: 'all' })}
      >
        All diagrams
      </button>
      <button
        type="button"
        className="dc-sidebar-row"
        data-active={view.kind === 'unorganized' ? 'true' : undefined}
        onClick={() => onViewChange({ kind: 'unorganized' })}
      >
        <span>Unorganized</span>
        <span className="dc-muted dc-sidebar-count">{unorganizedCount}</span>
      </button>

      <div className="dc-sidebar-section">
        <span className="dc-sidebar-eyebrow">Projects</span>
        {projectsSorted.map((project) => (
          <div
            key={project.id}
            className="dc-sidebar-project-row"
            data-active={view.kind === 'project' && view.projectId === project.id ? 'true' : undefined}
          >
            <button
              type="button"
              className="dc-sidebar-row"
              onClick={() => onViewChange({ kind: 'project', projectId: project.id })}
            >
              <span className="dc-sidebar-project-name">{project.name}</span>
              <span className="dc-muted dc-sidebar-count">{countByProject.get(project.id) ?? 0}</span>
            </button>
            <div className="dc-sidebar-project-actions">
              <Button
                icon="pencil"
                variant="quiet"
                aria-label={`Rename ${project.name}`}
                onClick={() => setRenaming(project)}
              />
              <Button
                icon="trash"
                variant="quiet"
                aria-label={`Delete ${project.name}`}
                onClick={() => setDeleting(project)}
              />
            </div>
          </div>
        ))}
        <button type="button" className="dc-sidebar-action" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} />
          New project
        </button>
      </div>

      {creating && (
        <ProjectNameDialog
          title="New project"
          submitLabel="Create"
          submitIcon="plus"
          initialValue=""
          onClose={() => setCreating(false)}
          onSubmit={(name) => {
            void session.createProject(name).then((project) => {
              if (project) onViewChange({ kind: 'project', projectId: project.id });
            });
            setCreating(false);
          }}
        />
      )}

      {renaming && (
        <ProjectNameDialog
          title="Rename project"
          submitLabel="Rename"
          submitIcon="check"
          initialValue={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => {
            void session.renameProject(renaming.id, name);
            setRenaming(null);
          }}
        />
      )}

      {deleting && (
        <Modal
          title="Delete this project?"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={() => {
                  void session.deleteProject(deleting.id);
                  if (view.kind === 'project' && view.projectId === deleting.id) {
                    onViewChange({ kind: 'recent' });
                  }
                  setDeleting(null);
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p>
            <strong>{deleting.name}</strong> will be removed.
          </p>
          <p className="dc-muted">
            Its diagrams are not deleted — they move back to Unorganized.
          </p>
        </Modal>
      )}
    </nav>
  );
}

function ProjectNameDialog({
  title,
  submitLabel,
  submitIcon,
  initialValue,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  submitIcon: 'plus' | 'check';
  initialValue: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const submit = () => {
    const name = value.trim();
    if (name) onSubmit(name);
    else onClose();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" icon={submitIcon} onClick={submit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <label className="dc-field">
        <span>Name</span>
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
