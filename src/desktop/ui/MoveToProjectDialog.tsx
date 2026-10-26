import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { Button } from '../../ui/common/Button';
import { Icon } from '../../ui/common/Icon';
import { Modal } from '../../ui/common/Modal';
import { DesktopError, type Handle } from '../api';
import type { ProjectState } from '../store';
import { folderOfPath, nextFreeName } from './fileTargets';

/**
 * "Move to Project…": every project as one row, and choosing a row is the move — there is nothing
 * else to confirm. The project the file already sits in says so and can't be chosen. A name taken in
 * the chosen project stops there and asks, under that row: keep both (the next free name), or not.
 * `onMove` is whichever of the controller's moves the caller needs; this only knows names and places.
 */
export function MoveToProjectDialog({
  name,
  fromPath,
  projects,
  clash: initialClash,
  failed,
  onMove,
  onAddProject,
  onClose,
}: {
  name: string;
  /** Where the file is now, as `displayPath`: what says which project is "here". */
  fromPath: string;
  projects: ProjectState[];
  /** A drop already found the name taken in this project: open on that question. */
  clash?: Handle;
  /** A drop that failed for another reason: shown under that project, as a click's failure would be. */
  failed?: { project: Handle; message: string };
  onMove: (project: Handle, keepBoth: boolean) => Promise<unknown>;
  onAddProject: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<Handle | null>(null);
  const [clash, setClash] = useState<Handle | null>(initialClash ?? null);
  const [error, setError] = useState<{ project: Handle; message: string } | null>(failed ?? null);
  const listRef = useRef<HTMLDivElement>(null);
  const here = folderOfPath(fromPath);
  const elsewhere = projects.filter((project) => project.info.displayPath !== here);

  // The first project that can be chosen has focus, so ↓/Enter is a move; a clash brought in by a
  // drop puts it on that question's answer instead.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    (list.querySelector<HTMLButtonElement>('.dc-move-clash .dc-button-solid') ?? list.querySelector<HTMLButtonElement>('.dc-move-row:not(:disabled)'))?.focus();
    // Only where the dialog opens.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = async (project: Handle, keepBoth = false) => {
    if (busy) return;
    setBusy(project);
    setError(null);
    try {
      await onMove(project, keepBoth);
      onClose();
    } catch (err) {
      setBusy(null);
      if (err instanceof DesktopError && err.kind === 'AlreadyExists') {
        setClash(project);
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('.dc-move-clash .dc-button-solid')?.focus());
        return;
      }
      setError({ project, message: err instanceof DesktopError ? err.message : 'Draft Canvas couldn’t move that file.' });
    }
  };

  /** ↑/↓, Home/End walk the rows that can be chosen; a letter jumps to the next project starting with it. */
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeKeyEvent(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.dc-move-row:not(:disabled)') ?? [])];
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, at + 1)];
    else if (event.key === 'ArrowUp') next = rows[Math.max(0, at - 1)];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows[rows.length - 1];
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const letter = event.key.toLowerCase();
      const after = [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
      next = after.find((row) => row.dataset.name?.toLowerCase().startsWith(letter));
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <Modal
      title={`Move “${name}”`}
      onClose={busy ? () => {} : onClose}
      width={440}
      className="dc-move-dialog"
      footer={
        <>
          <Button variant="quiet" icon="plus" className="dc-move-add" onClick={onAddProject} disabled={busy !== null}>
            Add project…
          </Button>
          <Button variant="quiet" onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
        </>
      }
    >
      {elsewhere.length === 0 ? (
        <div className="dc-move-empty">
          <span className="dc-move-empty-art" aria-hidden="true">
            <Icon name="move" size={28} />
          </span>
          <p>{projects.length === 0 ? 'No projects yet. Add a folder as a project, and diagrams can move into it.' : 'This is your only project. Add another, and diagrams can move into it.'}</p>
        </div>
      ) : (
        <>
          <p className="dc-move-lead">Choose where it goes. It moves into the project’s top folder, keeping its name.</p>
          <div className="dc-move-list" role="group" aria-label="Projects" ref={listRef} onKeyDown={onListKey}>
            {projects.map((project) => {
              const { handle } = project.info;
              const isHere = project.info.displayPath === here;
              const missing = project.status === 'missing';
              const moving = busy === handle;
              return (
                <div key={handle} className="dc-move-item" data-clash={clash === handle ? '' : undefined}>
                  <button
                    type="button"
                    className="dc-move-row"
                    data-name={project.info.name}
                    data-here={isHere ? '' : undefined}
                    data-moving={moving ? '' : undefined}
                    disabled={isHere || missing || (busy !== null && !moving)}
                    aria-describedby={error?.project === handle ? 'dc-move-error' : undefined}
                    title={project.info.displayPath}
                    onClick={() => {
                      setClash(null);
                      void move(handle);
                    }}
                  >
                    <span className="dc-move-glyph" aria-hidden="true">
                      <Icon name="folder" size={16} />
                    </span>
                    <span className="dc-move-text">
                      <span className="dc-move-name">{project.info.name}</span>
                      <span className="dc-move-path">{project.info.displayPath}</span>
                    </span>
                    <span className="dc-move-side">
                      {moving ? (
                        <span className="dc-move-status" role="status">
                          <span className="dc-move-spinner" aria-hidden="true" />
                          Moving…
                        </span>
                      ) : isHere ? (
                        <span className="dc-move-here">Here now</span>
                      ) : missing ? (
                        'Not found'
                      ) : project.status === 'ready' ? (
                        `${project.files.length} ${project.files.length === 1 ? 'diagram' : 'diagrams'}`
                      ) : (
                        <Icon name="forward" size={13} />
                      )}
                    </span>
                  </button>
                  {clash === handle && (
                    <div className="dc-move-clash" role="alert">
                      <p>
                        <strong>{project.info.name}</strong> already has a diagram called “{name}”. Keep both, or leave this one where it is?
                      </p>
                      <span className="dc-move-clash-actions">
                        <Button variant="quiet" onClick={() => setClash(null)} disabled={busy !== null}>
                          Don’t move
                        </Button>
                        <Button variant="solid" icon="copy" onClick={() => void move(handle, true)} disabled={busy !== null}>
                          Keep both as “{nextFreeName(name, project)}”
                        </Button>
                      </span>
                    </div>
                  )}
                  {error?.project === handle && (
                    <p id="dc-move-error" className="dc-export-note" data-invalid="true" role="alert">
                      {error.message}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
