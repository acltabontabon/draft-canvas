/**
 * The clipboard as a destination for an export: the same picture or text a file would get, handed
 * to the system clipboard instead. Where the browser offers no way to write it (Firefox has no
 * `ClipboardItem` for images; an insecure context has no async clipboard at all) the file is
 * downloaded instead and the result says so, so the caller can tell the user which one happened.
 * Nothing here reads the clipboard, and nothing leaves the machine — a write is the OS's own.
 */

import type { DraftDocument } from '../document/types';
import { downloadBlob, downloadText } from './download';
import { renderPngBlob, renderSvgText, type ImageExportOptions, type PngExportOptions } from './image';
import { fileNameFor } from './project';
import { SOURCE_FORMAT_INFO, sourceFileNameFor, sourceTextFor, type SourceFormat } from './source';

export type CopyResult = { copied: true } | { copied: false; downloaded: true };

const COPIED: CopyResult = { copied: true };
const DOWNLOADED: CopyResult = { copied: false, downloaded: true };

async function writeImage(blob: Blob): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || typeof navigator === 'undefined' || typeof navigator.clipboard?.write !== 'function') return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}

async function writeText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied, or not in a secure context: try the old way below.
    }
  }
  return legacyWriteText(text);
}

/** `execCommand('copy')` on a hidden textarea — what an insecure context or an old WebKit still has. */
function legacyWriteText(text: string): boolean {
  if (typeof window === 'undefined' || typeof window.document?.execCommand !== 'function') return false;
  const page = window.document;
  const area = page.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  page.body.appendChild(area);
  try {
    area.select();
    return page.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** The PNG the Image panel would download, on the clipboard — or downloaded when it cannot be. */
export async function copyImage(document: DraftDocument, options: PngExportOptions = {}): Promise<CopyResult> {
  const blob = await renderPngBlob(document, options);
  if (await writeImage(blob)) return COPIED;
  await downloadBlob(blob, fileNameFor(document.metadata.title, '.png'));
  return DOWNLOADED;
}

/** The SVG text, as text — pasteable into a README, an editor, or anything that reads markup. */
export async function copySvg(document: DraftDocument, options: ImageExportOptions = {}): Promise<CopyResult> {
  const svg = await renderSvgText(document, options);
  if (await writeText(svg)) return COPIED;
  await downloadText(svg, fileNameFor(document.metadata.title, '.svg'), 'image/svg+xml');
  return DOWNLOADED;
}

/** The source text in `format`, exactly what `exportSourceFile` would write. */
export async function copySource(document: DraftDocument, format: SourceFormat): Promise<CopyResult> {
  const text = sourceTextFor(document, format);
  if (await writeText(text)) return COPIED;
  await downloadText(text, sourceFileNameFor(document, format), SOURCE_FORMAT_INFO[format].mime);
  return DOWNLOADED;
}
