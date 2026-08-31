import { useRef, useState } from 'react';
import { readProjectFile } from '../../export/project';
import { looksLikeSecureExport, readSecureProjectFile } from '../../export/secureProject';
import type { DraftSummary } from '../../document/types';
import type { NormalizeResult } from '../../document/validate';
import { useUiStore } from '../../store/uiStore';
import type { DocumentSession } from '../../store/useDocumentSession';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { Modal } from '../common/Modal';
import { PrivacyNote } from '../PrivacyNote';

/**
 * The landing screen: a list of what is stored in this browser.
 *
 * Deliberately not a dashboard. There are no projects, no folders and no
 * sharing — just the diagrams on this device and a way into a new one.
 */
export function LibraryScreen({ session }: { session: DocumentSession }) {
  const notify = useUiStore((state) => state.notify);
  const setAboutOpen = useUiStore((state) => state.setAboutOpen);
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<DraftSummary | null>(null);
  const [renaming, setRenaming] = useState<DraftSummary | null>(null);
  const [securePendingFile, setSecurePendingFile] = useState<File | null>(null);

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
          <div>
            <div className="dc-brand">
              <h1>Draft Canvas</h1>
              <button
                type="button"
                className="dc-brand-about"
                onClick={() => setAboutOpen(true)}
                aria-label="About Draft Canvas"
                title="About Draft Canvas"
              >
                <Icon name="info" size={14} />
              </button>
            </div>
            <p className="dc-lede">A local-first canvas for explaining software.</p>
          </div>
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
        </header>

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

        <section className="dc-library-list">
          <div className="dc-library-list-head">
            <h2>Your diagrams</h2>
            <span className="dc-muted">Stored only on this device.</span>
          </div>

          {!session.ready && <p className="dc-muted dc-library-empty">Opening local storage…</p>}

          {session.ready && session.library.length === 0 && (
            <div className="dc-library-empty">
              <p>Nothing here yet.</p>
              <p className="dc-muted">
                Create a canvas, or import a <code>.draftcanvas</code> file you exported earlier.
              </p>
            </div>
          )}

          <ul>
            {session.library.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="dc-library-item"
                  onClick={() => void session.openDocument(entry.id)}
                >
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

        <PrivacyNote durable={session.durable} />
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

