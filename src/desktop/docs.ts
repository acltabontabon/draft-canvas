/**
 * Keeps a published docs image current: after a diagram file is saved — by the person, or by an
 * agent's change once the shell has actually written it — its picture beside it is drawn again from
 * exactly the text that was saved, if that picture asked for it (`sync` in its note).
 *
 * There is no list of publications to keep. The shell says whether a picture sits beside the file and
 * whether Draft Canvas made it; the picture's own note says which level, which look and whether to
 * follow saves. A picture someone else made, or one set to stay a snapshot, is never touched. The
 * shell writes it whole or not at all, and not at all when the bytes are the same, so a save that
 * changed nothing visible leaves the repository clean.
 */

import { deserializeDocument } from '../export/project';
import { renderDocsImage } from '../export/docs/image';
import { readMarker } from '../export/docs/marker';
import { logDiagnostic } from '../lib/diagnostics';
import type { DesktopApi, Handle } from './api';

type Notify = (message: string) => void;

interface Request {
  name: string;
  text: string;
  /** False for a file that isn't open: its background image isn't loaded, so its picture waits. */
  open: boolean;
}

export class DocsPublisher {
  /** The latest request per file, while one for it is already drawing. */
  private readonly queued = new Map<Handle, Request>();
  private readonly running = new Set<Handle>();
  /** Files whose missing level was already reported, so every save doesn't say it again. */
  private readonly reported = new Set<Handle>();

  private readonly api: DesktopApi;
  private readonly notify: Notify;

  constructor(api: DesktopApi, notify: Notify) {
    this.api = api;
    this.notify = notify;
  }

  /**
   * `text` was just saved to `handle` (named `name` without its extension). Redraws that file's
   * picture if it follows saves; one drawing per file at a time, the latest text winning.
   */
  refresh(handle: Handle, name: string, text: string, open = true): Promise<void> {
    this.queued.set(handle, { name, text, open });
    if (this.running.has(handle)) return Promise.resolve();
    return this.drain(handle);
  }

  private async drain(handle: Handle): Promise<void> {
    this.running.add(handle);
    try {
      for (let next = this.queued.get(handle); next; next = this.queued.get(handle)) {
        this.queued.delete(handle);
        await this.redraw(handle, next);
      }
    } finally {
      this.running.delete(handle);
    }
  }

  private async redraw(handle: Handle, request: Request): Promise<void> {
    let imageName = 'the docs image';
    try {
      const status = await this.api.docsStatus(handle);
      imageName = status.imageName;
      if (status.state !== 'ours' || status.svg === null) return;
      const marker = readMarker(status.svg);
      if (!marker?.settings.sync) return;
      const parsed = deserializeDocument(request.text);
      if (!parsed.ok) return;
      if (!request.open && parsed.document.settings.background.enabled) return;
      const rendered = await renderDocsImage(parsed.document, `${request.name}.draftcanvas`, marker.settings);
      if (!rendered.ok) {
        if (!this.reported.has(handle)) {
          this.reported.add(handle);
          this.notify(`${imageName} wasn’t updated: the level it shows is gone. Choose another in Use in docs.`);
        }
        return;
      }
      this.reported.delete(handle);
      await this.api.docsPublish(handle, rendered.svg);
    } catch (error) {
      logDiagnostic(error, { operation: 'desktop-docs' });
      this.notify(`Couldn’t update ${imageName}: ${error instanceof Error ? error.message : 'something went wrong.'}`);
    }
  }
}
