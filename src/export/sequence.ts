/**
 * SequenceModel -> downloaded file. Mirrors `project.ts`'s `exportProjectFile` pattern exactly:
 * build the model, render it, hand the text to `downloadText`. There is no image/rendered export
 * here — the source text IS the product (see `docs/ARCHITECTURE.md`).
 */
import type { DraftDocument } from '../document/types';
import { buildSequenceModel, toMermaid, toPlantUml } from '../sequence';
import { downloadText } from './download';
import { fileNameFor } from './project';

export const MERMAID_EXTENSION = '.sequence.mmd';
export const PLANTUML_EXTENSION = '.sequence.puml';
const SEQUENCE_MIME = 'text/plain';

export type SequenceFormat = 'mermaid' | 'plantuml';

/**
 * The sequence source text for the whole document's playable Flows, in the requested format —
 * the exact string the matching export function downloads and "Copy source"/"Copy as Markdown"
 * copy, so none of the three paths can ever drift from what the others produce.
 */
export function sequenceSourceFor(document: DraftDocument, format: SequenceFormat): string {
  const model = buildSequenceModel(document);
  return format === 'mermaid' ? toMermaid(model) : toPlantUml(model);
}

export function exportSequenceMermaidFile(document: DraftDocument): void {
  downloadText(sequenceSourceFor(document, 'mermaid'), fileNameFor(document.metadata.title, MERMAID_EXTENSION), SEQUENCE_MIME);
}

export function exportSequencePlantUmlFile(document: DraftDocument): void {
  downloadText(sequenceSourceFor(document, 'plantuml'), fileNameFor(document.metadata.title, PLANTUML_EXTENSION), SEQUENCE_MIME);
}
