import { parseDocument, type NormalizeResult } from '../document/validate';
import {
  decryptFromExport,
  encryptForExport,
  SECURE_EXPORT_FILE_EXTENSION,
  SECURE_EXPORT_MIME,
} from '../crypto/passphraseExport';
import type { DraftDocument } from '../document/types';
import { downloadText } from './download';
import { fileNameFor, readImportText } from './project';

export { SECURE_EXPORT_FILE_EXTENSION, SECURE_EXPORT_MIME };

/**
 * Writes a passphrase-protected `.dcenc` file. The passphrase never becomes,
 * and never touches, the local storage key (`crypto/keyStore.ts`) — see
 * `crypto/passphraseExport.ts`.
 */
export async function exportSecureProjectFile(document: DraftDocument, passphrase: string): Promise<void> {
  const text = await encryptForExport(document, passphrase);
  downloadText(text, fileNameFor(document.metadata.title, SECURE_EXPORT_FILE_EXTENSION), SECURE_EXPORT_MIME);
}

/**
 * Reads a `.dcenc` file: decrypt with the given passphrase, then feed the
 * result through the same untrusted-input funnel (`document/validate.ts`)
 * every import and every local record already goes through — an encrypted
 * export is not a more-trusted source than a plain one just because it
 * needed a passphrase to open. The caller re-encrypting with the local
 * profile key is not a separate step here: it falls out of the normal
 * `adoptDocument` → `repository.save()` path, which always encrypts.
 */
export async function readSecureProjectFile(file: File, passphrase: string): Promise<NormalizeResult> {
  const read = await readImportText(file);
  if (!read.ok) return read;
  const decrypted = await decryptFromExport(read.text, passphrase);
  if (!decrypted.ok) return decrypted;
  return parseDocument(decrypted.document);
}

/** By extension only — routes the import flow to the passphrase prompt
 *  instead of reading the file as plain `.draftcanvas` JSON. */
export function looksLikeSecureExport(file: File): boolean {
  return file.name.toLowerCase().endsWith(SECURE_EXPORT_FILE_EXTENSION);
}
