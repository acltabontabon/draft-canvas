/**
 * Keeps published docs pictures current: after a diagram file is saved — by the person, or by an
 * agent's change once the shell has actually written it — every picture of it beside it (the whole
 * diagram's, and each level's) is drawn again from exactly the text that was saved, if that picture
 * asked for it (`sync` in its note).
 *
 * There is no list of publications to keep. The shell lists the files named like the diagram's
 * pictures and says which Draft Canvas made; each picture's own note says which diagram, which level,
 * which look and whether to follow saves (`names.ts`). A picture someone else made, another
 * diagram's, or one set to stay a snapshot, is never touched. The shell writes each whole or not at
 * all, and not at all when the bytes are the same, so a save that changed nothing visible leaves the
 * repository clean.
 */

import { deserializeDocument } from '../export/project';
import { renderDocsImage } from '../export/docs/image';
import type { DocsSettings } from '../export/docs/marker';
import { picturesOf } from '../export/docs/names';
import { logDiagnostic } from '../lib/diagnostics';
import type { DesktopApi, DocsPublished, Handle } from './api';

type Notify = (message: string) => void;

interface Request {
  name: string;
  text: string;
  /** False for a file that isn't open: its background image isn't loaded, so its picture waits. */
  open: boolean;
}

/**
 * Every write of one file's pictures — a redraw after a save, or Publish/Update from Use in docs —
 * runs in one queue per file, in the order asked. Publish with unsaved changes saves first, and that
 * save asks for a redraw with the settings already on disk; run side by side, whichever write landed
 * last won, and a new level or look could be put back silently. In order, the person's choice is
 * always the last write.
 */
export class DocsPublisher {
  /** The tail of each file's queue. */
  private readonly chains = new Map<Handle, Promise<void>>();
  /** A redraw asked for but not started yet: later saves replace its text rather than queue more. */
  private readonly waiting = new Map<Handle, Request>();
  /** Files already told about something that keeps repeating (a missing level, a deferred redraw). */
  private readonly reported = new Set<string>();

  private readonly api: DesktopApi;
  private readonly notify: Notify;

  constructor(api: DesktopApi, notify: Notify) {
    this.api = api;
    this.notify = notify;
  }

  /**
   * `text` was just saved to `handle` (named `name` without its extension). Redraws that file's
   * picture if it follows saves, after anything already queued for it, the latest text winning.
   */
  refresh(handle: Handle, name: string, text: string, open = true): Promise<void> {
    const alreadyWaiting = this.waiting.has(handle);
    this.waiting.set(handle, { name, text, open });
    if (alreadyWaiting) return this.chains.get(handle) ?? Promise.resolve();
    return this.enqueue(handle, async () => {
      const request = this.waiting.get(handle);
      this.waiting.delete(handle);
      if (request) await this.redraw(handle, request);
    });
  }

  /**
   * Publish or Update: draws `text` with `settings` and writes it as `imageName`, after anything
   * queued for the file.
   */
  publish(handle: Handle, name: string, text: string, settings: DocsSettings, imageName: string): Promise<DocsPublished> {
    return this.enqueue(handle, async () => {
      const parsed = deserializeDocument(text);
      if (!parsed.ok) throw new Error(parsed.error);
      const rendered = await renderDocsImage(parsed.document, `${name}.draftcanvas`, settings);
      if (!rendered.ok) throw new Error('The level this picture shows no longer exists.');
      this.reported.delete(`level:${handle}:${imageName}`);
      return this.api.docsPublish(handle, imageName, rendered.svg);
    });
  }

  private enqueue<T>(handle: Handle, job: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(handle) ?? Promise.resolve();
    const result = previous.then(job, job);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.chains.set(handle, tail);
    void tail.then(() => {
      if (this.chains.get(handle) === tail) this.chains.delete(handle);
    });
    return result;
  }

  private once(key: string, message: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.notify(message);
  }

  private async redraw(handle: Handle, request: Request): Promise<void> {
    let pictures;
    try {
      pictures = picturesOf((await this.api.docsStatus(handle)).images, request.name).filter((picture) => picture.marker.settings.sync);
    } catch (error) {
      logDiagnostic(error, { operation: 'desktop-docs' });
      this.notify(`Couldn’t update the docs pictures of ${request.name}.draftcanvas: ${error instanceof Error ? error.message : 'something went wrong.'}`);
      return;
    }
    if (pictures.length === 0) return;
    const parsed = deserializeDocument(request.text);
    if (!parsed.ok) return;
    if (!request.open && parsed.document.settings.background.enabled) {
      const what = pictures.length === 1 ? `${pictures[0]!.name} will update` : `Its ${pictures.length} docs pictures will update`;
      this.once(`deferred:${handle}`, `${what} the next time ${request.name}.draftcanvas is opened and saved: its background image is only loaded then.`);
      return;
    }
    // One at a time, each on its own: a level that's gone, or a write that fails, leaves the others
    // to be drawn.
    for (const picture of pictures) {
      try {
        const rendered = await renderDocsImage(parsed.document, `${request.name}.draftcanvas`, picture.marker.settings);
        if (!rendered.ok) {
          this.once(`level:${handle}:${picture.name}`, `${picture.name} wasn’t updated: the level it shows is gone. It stays as it was.`);
          continue;
        }
        this.reported.delete(`level:${handle}:${picture.name}`);
        await this.api.docsPublish(handle, picture.name, rendered.svg);
      } catch (error) {
        logDiagnostic(error, { operation: 'desktop-docs' });
        this.notify(`Couldn’t update ${picture.name}: ${error instanceof Error ? error.message : 'something went wrong.'}`);
      }
    }
  }
}
