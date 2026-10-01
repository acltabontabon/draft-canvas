/**
 * What arrives on an open canvas from outside — pasted or dropped Mermaid text, a dropped file —
 * and where it goes. Text lands in the room being edited, as one undo step (`insertComposed`); a
 * file is a whole diagram, so it goes into the Library and opens, exactly as the Library's own
 * Import does (`import/route.ts` decides what the file is for both).
 *
 * The parser's sniff (`looksLikeMermaid`) is the only static import from `import/`: it runs on
 * every foreign paste. Laying a flowchart out pulls the layout engine, loaded once it is needed.
 */

import { routeImportFile, unsupportedNotice } from '../../import/route';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import type { DocumentSession } from '../../store/useDocumentSession';

export { looksLikeMermaid } from '../../import/mermaid/parse';

/** Lays a flowchart out and adds it to the current room, selected. Resolves to whether anything landed. */
export async function insertMermaidText(text: string): Promise<boolean> {
  const notify = useUiStore.getState().notify;
  const { importMermaid } = await import('../../import/mermaid');
  const imported = await importMermaid(text, 'Pasted flowchart');
  if (!imported.ok) {
    notify(imported.error, 'error');
    return false;
  }
  const added = useEditorStore.getState().insertComposed(imported.document, 'Import flowchart');
  if (added.length === 0) return false;
  // It lands at the first free place, which is often off the edge of what you were looking at: the
  // camera follows it, the way it does after Arrange.
  useUiStore.getState().requestFit();
  const notice = unsupportedNotice(imported.unsupported);
  if (notice) notify(notice);
  return true;
}

/** Imports a dropped file into the Library and opens it. */
export async function importDroppedFile(file: File, session: DocumentSession): Promise<void> {
  const notify = useUiStore.getState().notify;
  const routed = await routeImportFile(file);
  if (routed.kind === 'secure') {
    notify('An encrypted export asks for its passphrase in the Library: use Import there.');
    return;
  }
  if (!routed.result.ok) {
    notify(routed.result.error, 'error');
    return;
  }
  if (routed.result.repairs.length > 0) notify(`Imported with repairs: ${routed.result.repairs.join(' ')}`);
  const notice = unsupportedNotice(routed.unsupported ?? []);
  if (notice) notify(notice);
  await session.adoptDocument(routed.result.document);
}

/** Whether a drag carries something this canvas can take — files, or text that might be a flowchart. */
export function dragCarriesImport(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  const types = Array.from(transfer.types);
  return types.includes('Files') || types.includes('text/plain');
}
