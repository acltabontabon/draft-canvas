import { cloneDocumentAsNew } from '../document/factory';
import type { DraftDocument } from '../document/types';
import { LIMITS } from '../document/limits';
import { adoptEmbeddedBackground, backgroundTravels, withEmbeddedBackground } from '../export/background';
import { fileNameFor, readProjectFile, serializeDocument } from '../export/project';
import { fileWithLiveViewport, useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import type { DocumentSession } from '../store/useDocumentSession';
import type { DraftRepository } from './DraftRepository';
import type { BrowserFileActions, BrowserFileAdapter, FileAssociation, LocalFileHandle } from './fileHandles';

export async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Camera motion and save timestamps do not turn a disk file dirty. All diagram content does. */
export function contentFingerprint(document: DraftDocument): Promise<string> {
  const portable: unknown = JSON.parse(serializeDocument(document));
  return fingerprint(JSON.stringify(portable, (key, value: unknown) => key === 'viewport' || key === 'updatedAt' ? undefined : value));
}

export class BrowserFiles implements BrowserFileActions {
  private associations: FileAssociation[] = [];
  private busy = false;
  private generation = 0;
  private disposed = false;
  private refreshing = new Set<string>();

  private readonly repository: DraftRepository;
  private readonly adapter: BrowserFileAdapter;
  private readonly session: () => DocumentSession;
  private readonly faults = new Set<string>();

  constructor(repository: DraftRepository, adapter: BrowserFileAdapter, session: () => DocumentSession) {
    this.repository = repository;
    this.adapter = adapter;
    this.session = session;
  }

  async initialize() { await this.reloadAssociations(); }
  dispose() { this.disposed = true; this.generation++; useUiStore.getState().fileQuestion?.answer('cancel'); }

  private async reloadAssociations() {
    this.associations = await this.repository.listFileAssociations!();
    if (!this.disposed) useUiStore.setState({ browserFileNames: Object.fromEntries(this.associations.map((item) => [item.documentId, item.handle.name])) });
  }

  private label(id: string, label: string) {
    if (!this.disposed) useUiStore.setState((state) => ({ browserFileLabels: { ...state.browserFileLabels, [id]: label } }));
  }

  async updateStatus() {
    const generation = ++this.generation;
    const id = this.session().openId;
    if (!id || this.faults.has(id) || useUiStore.getState().readOnly) return;
    const association = this.associations.find((item) => item.documentId === id);
    if (!association) return;
    const snapshot = fileWithLiveViewport(useEditorStore.getState());
    const hash = await contentFingerprint(snapshot);
    if (generation !== this.generation || this.disposed) return;
    const recovered = useEditorStore.getState().save;
    this.label(id, hash === association.savedContentHash ? `Saved to ${association.handle.name}` : (recovered.status === 'saved' || recovered.status === 'idle')
      ? `Changes recovered in this browser — ${association.handle.name} not updated`
      : `Changes not saved to ${association.handle.name}`);
  }

  private async question(title: string, message: string, options: { id: string; label: string }[]): Promise<string> {
    if (this.disposed) return 'cancel';
    return new Promise((resolve) => {
      useUiStore.setState({ fileQuestion: { title, message, options, answer: (id) => {
        useUiStore.setState({ fileQuestion: null });
        resolve(id);
      } } });
    });
  }

  private async permission(handle: LocalFileHandle, mode: 'read' | 'readwrite', request: boolean) {
    // Save is entered directly from a click/chord. Request first to retain that activation.
    return (request ? await handle.requestPermission({ mode }) : await handle.queryPermission({ mode })) === 'granted';
  }

  private async parsedFile(handle: LocalFileHandle) {
    const file = await handle.getFile();
    const parsed = await readProjectFile(file);
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.repairs.length) useUiStore.getState().notify(`Opened with repairs: ${parsed.repairs.join(' ')}`);
    return { document: parsed.document, diskHash: await fingerprint(await file.text()) };
  }

  async open() {
    if (this.busy || useUiStore.getState().flowTrace) return;
    this.busy = true;
    try {
      const handle = await this.adapter.open();
      if (!handle) return;
      if (!(await this.session().closeDocument())) return;
      await this.reloadAssociations();
      for (const association of this.associations) {
        if (await handle.isSameEntry(association.handle)) {
          // The picker grants fresh read access; keep the baseline, replace the capability.
          await this.repository.putFileAssociation!({ ...association, handle });
          await this.session().openDocument(association.documentId);
          return;
        }
      }
      const incoming = await this.parsedFile(handle);
      const document = cloneDocumentAsNew(incoming.document, incoming.document.metadata.title);
      await this.session().adoptDocument(document);
      const editor = useEditorStore.getState();
      if (editor.document.metadata.id !== document.metadata.id || !(await this.repository.has(document.metadata.id))) return;
      const association: FileAssociation = { documentId: document.metadata.id, handle, diskHash: incoming.diskHash,
        savedContentHash: await contentFingerprint(fileWithLiveViewport(editor)), savedAt: null };
      await this.repository.putFileAssociation!(association);
      await this.reloadAssociations();
      await this.updateStatus();
    } catch (error) { this.report(error); }
    finally { this.busy = false; }
  }

  async refreshOnOpen(id: string): Promise<boolean> {
    if (this.refreshing.has(id)) return true;
    this.refreshing.add(id);
    try {
      await this.reloadAssociations();
      const association = this.associations.find((item) => item.documentId === id);
      if (!association) return true;
      if (!(await this.permission(association.handle, 'read', false))) {
        this.faults.add(id);
        this.label(id, `Recovered copy — permission required for ${association.handle.name}`);
        return true;
      }
      this.faults.delete(id);
      const disk = await this.parsedFile(association.handle);
      if (disk.diskHash === association.diskHash) return true;
      const recovered = await this.repository.load(id);
      if (!recovered) return false;
      if (await contentFingerprint(recovered) !== association.savedContentHash) {
        const choice = await this.question('File and recovered copy changed', `${association.handle.name} changed on disk. Your browser also has unsaved changes.`, [
          { id: 'disk', label: 'Use disk version' }, { id: 'save-as', label: 'Save recovered copy as…' }, { id: 'cancel', label: 'Cancel' },
        ]);
        if (choice === 'cancel') return false;
        if (choice === 'save-as') {
          const handle = await this.adapter.save(fileNameFor(recovered.metadata.title));
          if (!handle) return false;
          return this.adapter.exclusive(() => this.writeSnapshot(recovered, handle, undefined));
        }
      }
      await this.replaceRecovery(disk.document, association, disk.diskHash);
      return true;
    } catch (error) {
      this.report(error, id);
      // A missing file must not make its recovery copy inaccessible.
      return true;
    } finally { this.refreshing.delete(id); }
  }

  private async replaceRecovery(document: DraftDocument, association: FileAssociation, diskHash: string) {
    const recovery = { ...document, metadata: { ...document.metadata, id: association.documentId } };
    const adopted = await adoptEmbeddedBackground(recovery, this.repository);
    await this.repository.save(adopted);
    await this.repository.putFileAssociation!({ ...association, diskHash, savedContentHash: await contentFingerprint(adopted) });
    await this.reloadAssociations();
  }

  async save(as = false) {
    if (this.busy || !this.session().openId || useUiStore.getState().readOnly || useUiStore.getState().flowTrace) return;
    const editor = useEditorStore.getState();
    if (editor.save.conflict) { useUiStore.getState().notify('Resolve the browser recovery conflict before saving the file.', 'error'); return; }
    this.busy = true;
    const snapshot = fileWithLiveViewport(editor);
    const id = snapshot.metadata.id;
    try {
      const known = this.associations.find((item) => item.documentId === id);
      // Before any asynchronous preparation: the picker/permission request needs this user gesture.
      const handle = as || !known ? await this.adapter.save(fileNameFor(snapshot.metadata.title)) : known.handle;
      if (!handle) return;
      if (!(await this.permission(handle, 'readwrite', true))) {
        this.faults.add(id);
        this.label(id, `Permission required — ${handle.name} not updated`);
        return;
      }
      await this.adapter.exclusive(async () => {
        await this.reloadAssociations();
        const baseline = this.associations.find((item) => item.documentId === id);
        const same = baseline && await handle.isSameEntry(baseline.handle);
        if (useEditorStore.getState().save.conflict) throw new Error('Resolve the browser recovery conflict before saving the file.');
        let approvedHash = await fingerprint(await (await handle.getFile()).text());
        if (same && baseline) {
          const diskHash = await fingerprint(await (await handle.getFile()).text());
          if (diskHash !== baseline.diskHash || (known && known.diskHash !== baseline.diskHash)) {
            const choice = await this.question('File changed on disk', `${handle.name} has changed since Draft Canvas last read or saved it.`, [
              { id: 'reload', label: 'Reload file' }, { id: 'save-as', label: 'Save As…' }, { id: 'overwrite', label: 'Overwrite' }, { id: 'cancel', label: 'Cancel' },
            ]);
            if (choice === 'cancel') return;
            if (choice === 'reload') {
              if (this.session().openId !== id || useEditorStore.getState().revision !== editor.revision) throw new Error('The diagram changed while the choice was open. Save again to review the current changes.');
              const disk = await this.parsedFile(handle);
              await this.replaceRecovery(disk.document, baseline, disk.diskHash);
              if (this.session().openId === id) await this.session().openDocument(id);
              return;
            }
            approvedHash = diskHash;
            if (choice === 'save-as') {
              const other = await this.adapter.save(fileNameFor(snapshot.metadata.title));
              if (other) await this.writeSnapshot(snapshot, other, undefined);
              return;
            }
          }
        }
        await this.writeSnapshot(snapshot, handle, baseline, approvedHash);
      });
    } catch (error) { this.report(error, id); }
    finally { this.busy = false; }
  }

  private async writeSnapshot(snapshot: DraftDocument, handle: LocalFileHandle, previous: FileAssociation | undefined, expectedDiskHash?: string): Promise<boolean> {
    // A file already linked to another Library item has its own recovery history.
    for (const item of this.associations) {
      if (item.documentId !== snapshot.metadata.id && await handle.isSameEntry(item.handle)) {
        throw new Error('That file belongs to another diagram in your Library. Open that diagram or choose another file.');
      }
    }
    const expected = expectedDiskHash ?? await fingerprint(await (await handle.getFile()).text());
    const travels = await backgroundTravels(snapshot);
    if (snapshot.settings.background.enabled && travels !== 'embedded') {
      const answer = await this.question('Background will not be included', 'The configured background is missing or too large for an editable file. Continue without it?', [
        { id: 'continue', label: 'Save without background' }, { id: 'cancel', label: 'Cancel' },
      ]);
      if (answer !== 'continue') return false;
    }
    const text = serializeDocument(await withEmbeddedBackground(snapshot));
    if (new TextEncoder().encode(text).length > LIMITS.maxFileBytes) throw new Error('This diagram is too large to save as a file that Draft Canvas can reopen.');
    const diskHash = await fingerprint(text);
    const savedContentHash = await contentFingerprint(snapshot);
    // The picker already confirms replacement for Save As; existing-file conflicts were checked above.
    if (await fingerprint(await (await handle.getFile()).text()) !== expected) throw new Error('The file changed again while preparing the save. Save again to review it.');
    if (useEditorStore.getState().save.conflict) throw new Error('Resolve the browser recovery conflict before saving the file.');
    const writer = await handle.createWritable();
    try { await writer.write(text); await writer.close(); }
    catch (error) { await writer.abort().catch(() => {}); throw error; }
    try {
      await this.repository.putFileAssociation!({ documentId: snapshot.metadata.id, handle, diskHash, savedContentHash, savedAt: Date.now() });
    } catch {
      this.label(snapshot.metadata.id, `Written to ${handle.name}, but its file link could not be remembered`);
      useUiStore.getState().notify(`Written to ${handle.name}, but the file link could not be remembered. Use Open file to reconnect it.`, 'error');
      return true;
    }
    this.faults.delete(snapshot.metadata.id);
    await this.reloadAssociations();
    await this.updateStatus();
    if (!previous) useUiStore.getState().notify(`Saved to ${handle.name}.`);
    return true;
  }

  private report(error: unknown, id?: string) {
    if (error instanceof Error && error.name === 'AbortError') return;
    const message = error instanceof Error ? error.message : 'The file could not be read or written.';
    if (id) this.faults.add(id);
    if (id) this.label(id, `File not updated — ${message}`);
    useUiStore.getState().notify(message, 'error');
  }
}
