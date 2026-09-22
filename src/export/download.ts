/**
 * Everything Draft Canvas "exports" is written straight from memory to a local
 * download. No request is made, and nothing passes through a server on the way.
 */

/**
 * Where an export goes when the browser's download isn't it. The desktop app sets one that opens a
 * Save dialog; cancelling it rejects with an `AbortError`, which the export dialog treats as the
 * user changing their mind rather than a failure.
 */
export type FileSaver = (blob: Blob, fileName: string) => Promise<void>;

let saver: FileSaver | null = null;

export function setFileSaver(next: FileSaver | null): void {
  saver = next;
}

export async function downloadBlob(blob: Blob, fileName: string): Promise<void> {
  if (saver) return saver(blob, fileName);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(text: string, fileName: string, mime: string): Promise<void> {
  return downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), fileName);
}
