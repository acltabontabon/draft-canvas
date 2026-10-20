import { useEffect, useRef, useState } from 'react';
import { ListBox, ListBoxItem } from 'react-aria-components';
import type { ExplorerSaveRequest } from '../saveExplorer';
import type { DesktopController } from '../controller';
import type { ExplorerDirectory, ExplorerEntry, ExplorerStart } from '../api';
import { thumbnailOf, type Thumbnail } from '../thumbnails';
import { Button } from '../../ui/common/Button';
import { Icon } from '../../ui/common/Icon';
import { Modal } from '../../ui/common/LazyModal';
import { StarterGlyph } from '../../ui/Library/StarterGlyph';
import '../../ui/Library/project-dialog.css';
import './file-explorer.css';
import '../../ui/Library/library-theme.css';

// Two symlink names can lead to the same canonical handle while remaining separate rows.
const entryKey = (entry: ExplorerEntry) => `${entry.handle}:${entry.name}`;
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'This folder couldn’t be opened. Try another location.';
const bytesOf = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Browse with temporary Rust capabilities. Only Add/Open commits a normal project/file grant. */
export function FileExplorerDialog({ controller, onClose, mode, saveRequest }: { controller: DesktopController; onClose: () => void; mode: 'project' | 'file' | 'save'; saveRequest?: ExplorerSaveRequest }) {
  const fileMode = mode === 'file';
  const saveMode = mode === 'save';
  const [fileName, setFileName] = useState(saveRequest?.suggestedName ?? 'Untitled canvas');
  const [replacement, setReplacement] = useState<{ name: string; stamp: string; changed: boolean } | null>(null);
  const fileNameInput = useRef<HTMLInputElement>(null);
  const [start, setStart] = useState<ExplorerStart | null>(null);
  const [directory, setDirectory] = useState<ExplorerDirectory | null>(null);
  const [history, setHistory] = useState<{ items: string[]; index: number }>({ items: [], index: -1 });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Thumbnail>({ state: 'blank' });
  const [error, setError] = useState('');
  const [folderName, setFolderName] = useState<string | null>(null);
  const [folderError, setFolderError] = useState('');
  const newFolderButton = useRef<HTMLButtonElement>(null);
  const newFolderInput = useRef<HTMLInputElement>(null);
  const primaryButton = useRef<HTMLButtonElement>(null);
  const createdFolderFocus = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [boot, setBoot] = useState(0);
  const alive = useRef(true);
  const commitLock = useRef(false);
  const request = useRef(0);
  const initial = useRef('');
  const pathRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const target = history.items[history.index];
  const entry = directory?.entries.find((item) => entryKey(item) === selected);
  const folder = entry?.kind === 'folder' ? entry : directory?.location;
  const ready = Boolean(start && directory && target === directory.location.handle && !loading && !committing);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let session: string | undefined;
    setLoading(true);
    setError('');
    void controller.explorerOpen(saveRequest?.startIn).then((result) => {
      session = result.session;
      if (!active) { void controller.explorerClose(session).catch(() => {}); return; }
      initial.current = `${result.directory.location.handle}:false:`;
      setStart(result);
      setDirectory(result.directory);
      setHistory({ items: [result.directory.location.handle], index: 0 });
      setLoading(false);
    }).catch((error: unknown) => { if (active) { setError(messageOf(error)); setLoading(false); } });
    return () => {
      active = false;
      if (session) void controller.explorerClose(session).catch(() => {});
    };
  }, [controller, boot, saveRequest]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setFilter(query.trim()), 150);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    if (!start || !target) return;
    const signature = `${target}:${hidden}:${filter}`;
    if (initial.current === signature && retry === 0) { initial.current = ''; return; }
    const sequence = ++request.current;
    let active = true;
    setLoading(true);
    setPaging(false);
    setSelected(null);
    setError('');
    void controller.explorerList(start.session, target, hidden, filter).then((result) => {
      if (active && sequence === request.current) { setDirectory(result); setLoading(false); }
    }).catch((error: unknown) => {
      if (active && sequence === request.current) { setError(messageOf(error)); setLoading(false); }
    });
    return () => { active = false; };
  }, [controller, start, target, hidden, filter, retry]);

  useEffect(() => {
    let active = true;
    if (!start || entry?.kind !== 'file') { setPreview({ state: 'blank' }); return; }
    setPreview({ state: 'loading' });
    void controller.explorerPeek(start.session, entry.handle).then((text) => {
      if (active) setPreview(thumbnailOf(text));
    }).catch(() => { if (active) setPreview({ state: 'blank' }); });
    return () => { active = false; };
  }, [controller, start, entry]);

  useEffect(() => {
    if (pathRef.current) pathRef.current.scrollLeft = pathRef.current.scrollWidth;
    if (!loading && directory?.location.handle === createdFolderFocus.current) {
      createdFolderFocus.current = null;
      if (saveMode) fileNameInput.current?.focus();
      else if (fileMode) listRef.current?.focus();
      else primaryButton.current?.focus();
    }
  }, [directory?.location.handle, loading, fileMode, saveMode]);

  useEffect(() => { setReplacement(null); }, [fileName, target]);

  const selectEntry = (key: string | null) => {
    setSelected(key);
    const selected = directory?.entries.find((item) => entryKey(item) === key);
    if (saveMode && selected?.kind === 'file') setFileName(selected.name.replace(/\.draftcanvas$/i, ''));
  };
  const saveDiagram = async () => {
    if (!start || !directory || !saveRequest || !ready || !fileName.trim() || commitLock.current) return;
    commitLock.current = true;
    setCommitting(true); setError('');
    try {
      const result = await saveRequest.save(start.session, directory.location.handle, fileName, replacement?.stamp);
      if (alive.current && result.outcome === 'exists') setReplacement({ name: result.name, stamp: result.stamp, changed: replacement !== null });
    } catch (error) {
      if (alive.current) {
        setError(messageOf(error)); setReplacement(null);
        requestAnimationFrame(() => fileNameInput.current?.focus());
      }
    } finally {
      commitLock.current = false;
      if (alive.current) setCommitting(false);
    }
  };
  const navigate = (handle: string) => {
    if (committing || handle === target) return;
    setQuery('');
    setFilter('');
    setSelected(null);
    setFolderName(null);
    setFolderError('');
    setHistory({ items: [...history.items.slice(0, history.index + 1), handle], index: history.index + 1 });
  };
  const travel = (index: number) => {
    setQuery(''); setFilter(''); setSelected(null);
    setFolderName(null); setFolderError('');
    setHistory({ ...history, index });
  };
  const cancelNewFolder = () => {
    setFolderName(null);
    setFolderError('');
    requestAnimationFrame(() => newFolderButton.current?.focus());
  };
  const createFolder = async () => {
    if (!start || !directory || !ready || folderName === null || !folderName.trim() || commitLock.current) return;
    commitLock.current = true;
    setCommitting(true);
    setFolderError('');
    try {
      const created = await controller.explorerCreateFolder(start.session, directory.location.handle, folderName);
      if (!alive.current) return;
      createdFolderFocus.current = created.handle;
      setQuery(''); setFilter(''); setSelected(null); setFolderName(null);
      setHistory({ items: [...history.items.slice(0, history.index + 1), created.handle], index: history.index + 1 });
    } catch (error) {
      if (alive.current) {
        setFolderError(messageOf(error));
        requestAnimationFrame(() => newFolderInput.current?.focus());
      }
    } finally {
      commitLock.current = false;
      if (alive.current) setCommitting(false);
    }
  };
  const addProject = async () => {
    if (!start || !folder || !ready || commitLock.current) return;
    commitLock.current = true;
    setCommitting(true); setError('');
    try { await controller.explorerAddProject(start.session, folder.handle); if (alive.current) onClose(); }
    catch (error) { if (alive.current) setError(messageOf(error)); }
    finally { commitLock.current = false; if (alive.current) setCommitting(false); }
  };
  const activate = async (item: ExplorerEntry) => {
    if (item.kind === 'folder') { navigate(item.handle); return; }
    if (saveMode) { selectEntry(entryKey(item)); return; }
    if (!start || commitLock.current) return;
    setSelected(entryKey(item));
    commitLock.current = true;
    setCommitting(true); setError('');
    try { const opened = await controller.explorerOpenFile(start.session, item.handle); if (opened && alive.current) onClose(); }
    catch (error) { if (alive.current) setError(messageOf(error)); }
    finally { commitLock.current = false; if (alive.current) setCommitting(false); }
  };
  const more = async () => {
    if (!start || !directory || directory.nextOffset === null || paging) return;
    const sequence = request.current;
    setPaging(true);
    try {
      const result = await controller.explorerList(start.session, directory.location.handle, hidden, filter, directory.nextOffset);
      if (alive.current && sequence === request.current) setDirectory({ ...result, entries: [...directory.entries, ...result.entries] });
    } catch (error) { if (alive.current && sequence === request.current) setError(messageOf(error)); }
    finally { if (alive.current && sequence === request.current) setPaging(false); }
  };
  const parent = directory?.breadcrumbs.at(-2);
  const primaryLabel = committing ? saveMode ? 'Saving…' : 'Working…' : saveMode ? entry?.kind === 'folder' ? 'Open folder' : replacement ? 'Replace diagram' : 'Save diagram' : fileMode ? entry?.kind === 'folder' ? 'Open folder' : 'Open diagram' : 'Add project';
  const primaryIcon = saveMode ? entry?.kind === 'folder' ? 'forward' : 'file' : fileMode ? entry?.kind === 'folder' ? 'forward' : 'file' : 'plus';
  const primaryDisabled = !ready || folderName !== null || (fileMode && !entry) || (saveMode && entry?.kind !== 'folder' && !fileName.trim());
  const submit = () => {
    if (saveMode) { if (entry?.kind === 'folder') navigate(entry.handle); else void saveDiagram(); }
    else if (fileMode) { if (entry) void activate(entry); }
    else void addProject();
  };

  return (
    <Modal title={saveMode ? 'Save diagram as' : fileMode ? 'Open a diagram' : 'Add a project'} className={`dc-project-dialog dc-file-explorer${saveMode ? ' dc-file-explorer-save' : ''}`} width={980} onClose={() => { if (!saveMode || !committing) onClose(); }}
      footer={saveMode ? <form className="dc-explorer-save-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="dc-explorer-save-name"><span>File name</span><div><input ref={fileNameInput} aria-label="File name" autoFocus onFocus={(event) => event.currentTarget.select()} value={fileName} onChange={(event) => { setFileName(event.target.value); setSelected(null); setError(''); }} disabled={committing} /><span>.draftcanvas</span></div></label>
        {replacement && <div className="dc-explorer-replace" role="alert"><span><strong>{replacement.name}</strong>{replacement.changed ? ' changed since confirmation. Replace its latest version?' : ' already exists here. Replace it?'}</span><Button variant="quiet" onClick={() => { setReplacement(null); fileNameInput.current?.focus(); fileNameInput.current?.select(); }} disabled={committing}>Change name</Button></div>}
        <div className="dc-explorer-save-actions"><Button ref={primaryButton} type="submit" variant="solid" icon={primaryIcon} disabled={primaryDisabled}>{primaryLabel}</Button></div>
      </form> : <>
        {!fileMode && entry?.kind === 'folder' && <div className="dc-explorer-destination"><strong title={entry.displayPath}>{entry.displayPath}</strong></div>}
        <Button ref={primaryButton} variant="solid" icon={primaryIcon} onClick={submit} disabled={primaryDisabled}>{primaryLabel}</Button>
      </>}>

      <div className="dc-explorer-workspace">
        <aside className="dc-explorer-places" aria-label="Places">
          <h3>Places</h3>
          {start?.places.filter((place) => !place.project).map(({ location }) => <button type="button" key={location.handle} onClick={() => navigate(location.handle)} disabled={committing} aria-current={target === location.handle ? 'location' : undefined}><Icon name="folder" /><span>{location.name}</span></button>)}
          {start?.places.some((place) => place.project) && <h3>Your projects</h3>}
          {start?.places.filter((place) => place.project).map(({ location }) => <button type="button" key={location.handle} title={location.displayPath} onClick={() => navigate(location.handle)} disabled={committing} aria-current={target === location.handle ? 'location' : undefined}><Icon name="folder" /><span>{location.name}</span></button>)}
        </aside>
        <section className="dc-explorer-main" aria-label="Folder browser">
          <div className="dc-explorer-toolbar">
            <Button variant="quiet" icon="back" aria-label="Back" disabled={history.index <= 0 || committing} onClick={() => travel(history.index - 1)} />
            <Button variant="quiet" icon="forward" aria-label="Forward" disabled={history.index >= history.items.length - 1 || committing} onClick={() => travel(history.index + 1)} />
            <Button variant="quiet" icon="up" aria-label="Enclosing folder" disabled={!parent || !ready} onClick={() => parent && navigate(parent.handle)} />
            <nav ref={pathRef} aria-label="Folder path">{directory?.breadcrumbs.map((crumb, index) => <span key={crumb.handle}>{index > 0 && <Icon name="forward" size={11} />}<button type="button" onClick={() => navigate(crumb.handle)} disabled={committing} aria-current={crumb.handle === target ? 'location' : undefined}>{crumb.name || 'Computer'}</button></span>)}</nav>
            <Button variant="quiet" icon="refresh" aria-label="Refresh folder" disabled={!start || loading || committing} onClick={() => setRetry(retry + 1)} />
          </div>
          <div className="dc-explorer-filter"><label><Icon name="search" size={16} /><input aria-label="Find in this folder" placeholder="Find in this folder…" value={query} onChange={(event) => setQuery(event.target.value)} disabled={!start || committing} /></label><label className="dc-explorer-hidden"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} disabled={!start || committing} />Hidden</label><Button ref={newFolderButton} variant="quiet" icon="plus" className="dc-explorer-new-folder" disabled={!ready || folderName !== null} onClick={() => { setFolderName(''); setFolderError(''); }}>New folder</Button></div>
          {folderName !== null && <form className="dc-explorer-create" aria-label="Create a folder" onSubmit={(event) => { event.preventDefault(); void createFolder(); }}>
            <label htmlFor="dc-new-folder-name">Folder name</label>
            <div><Icon name="folder" size={20} /><input ref={newFolderInput} id="dc-new-folder-name" autoFocus aria-label="Folder name" aria-invalid={Boolean(folderError)} aria-describedby={folderError ? 'dc-new-folder-error' : undefined} value={folderName} onChange={(event) => { setFolderName(event.target.value); setFolderError(''); }} disabled={committing} /><Button variant="quiet" onClick={cancelNewFolder} disabled={committing}>Cancel</Button><Button variant="solid" type="submit" disabled={!ready || !folderName.trim()}>{committing ? 'Creating…' : 'Create folder'}</Button></div>
            {folderError && <p id="dc-new-folder-error" role="alert">{folderError}</p>}
          </form>}
          {error && <div className="dc-explorer-error" role="alert"><span>{error}</span><button type="button" onClick={() => start ? setRetry(retry + 1) : setBoot(boot + 1)}>Try again</button></div>}
          <div className="dc-explorer-content" data-preview={entry?.kind === 'file' ? 'true' : undefined} aria-busy={loading}>
            <div className="dc-explorer-list-wrap">
              <div className="dc-explorer-columns" aria-hidden="true"><span>Name</span><span>Modified</span></div>
              {loading ? <p className="dc-explorer-empty" role="status">Opening folder…</p> : directory && target === directory.location.handle ? <>
                <ListBox ref={listRef} aria-label="Folders and diagrams" className="dc-explorer-list" selectionMode="single" selectionBehavior="replace" items={directory.entries} selectedKeys={selected ? [selected] : []}
                  onSelectionChange={(keys) => selectEntry(keys === 'all' ? null : String([...keys][0] ?? '') || null)}
                  onAction={(key) => { const item = directory.entries.find((entry) => entryKey(entry) === key); if (item) void activate(item); }}
                  renderEmptyState={() => <div className="dc-explorer-empty"><Icon name="folder" size={36} /><span>{filter ? 'No matches in this folder' : 'No folders or diagrams here.'}</span></div>}>
                  {(item) => <ListBoxItem id={entryKey(item)} textValue={item.name} aria-label={item.name} className="dc-explorer-item" isDisabled={committing}>
                    <Icon name={item.kind === 'folder' ? 'folder' : 'file'} size={20} /><span className="dc-explorer-filename">{item.name}{item.kind === 'file' && <small>{bytesOf(item.size ?? 0)}</small>}</span><time>{item.modifiedMs ? new Date(item.modifiedMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}</time>{item.kind === 'folder' && <Icon name="forward" size={13} />}
                  </ListBoxItem>}
                </ListBox>
                {directory.nextOffset !== null && <Button variant="quiet" className="dc-explorer-more" onClick={() => void more()} disabled={paging}>{paging ? 'Loading…' : `Show more · ${directory.entries.length} of ${directory.total}`}</Button>}
                {directory.truncated && <p className="dc-explorer-limit">Showing the first 10,000 items. Choose a smaller folder to continue.</p>}
              </> : null}
            </div>
            {entry?.kind === 'file' && <aside className="dc-explorer-preview" aria-label="Selection preview">
              <h3>Preview</h3>
              <div className="dc-explorer-paper">{preview.state === 'drawn' ? <StarterGlyph starter={preview.shape} /> : <Icon name="file" size={44} />}</div>
              {preview.state !== 'drawn' && <p role="status">{preview.state === 'loading' ? 'Drawing preview…' : 'No preview available'}</p>}
              {!fileMode && !saveMode && <Button variant="quiet" icon="file" onClick={() => void activate(entry)} disabled={!ready}>Open diagram</Button>}
            </aside>}
          </div>
        </section>
      </div>
    </Modal>
  );
}
