import { parseDocument, type NormalizeResult } from '../document/validate';
import {
  decryptFromExport,
  encryptForExport,
  SECURE_EXPORT_FILE_EXTENSION,
  SECURE_EXPORT_FORMAT,
  SECURE_EXPORT_MIME,
} from '../crypto/passphraseExport';
import type { DraftDocument } from '../document/types';
import { downloadText } from './download';
import { fileNameFor, readImportText } from './project';

export { SECURE_EXPORT_FILE_EXTENSION };

/**
 * Writes a passphrase-protected `.dcenc` file. The passphrase never becomes,
 * and never touches, the local storage key (`crypto/keyStore.ts`) — see
 * `crypto/passphraseExport.ts`.
 */
export async function exportSecureProjectFile(document: DraftDocument, passphrase: string): Promise<void> {
  // Like the plain export, without the project it's filed under here: that id means nothing anywhere else.
  const { projectId: _local, ...metadata } = document.metadata;
  const text = await encryptForExport({ ...document, metadata }, passphrase);
  await downloadText(text, fileNameFor(document.metadata.title, SECURE_EXPORT_FILE_EXTENSION), SECURE_EXPORT_MIME);
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

/**
 * Whether an import needs the passphrase prompt instead of being read as plain `.draftcanvas` JSON.
 * The extension decides it when it's there; a file that lost it along the way (saved or mailed as
 * `.json`) is recognised by its format marker, which leads the envelope — otherwise it would be
 * turned away as "not a Draft Canvas document".
 */
export async function looksLikeSecureExport(file: File): Promise<boolean> {
  if (file.name.toLowerCase().endsWith(SECURE_EXPORT_FILE_EXTENSION)) return true;
  try {
    const head = await file.slice(0, 256).text();
    return new RegExp(`^\\s*\\{\\s*"format"\\s*:\\s*"${SECURE_EXPORT_FORMAT}"`).test(head);
  } catch {
    return false;
  }
}
