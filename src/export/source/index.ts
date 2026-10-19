/**
 * Every text a diagram can be exported as, under one id each. Two families: the sequence formats
 * read a Flow's telling (`../sequence.ts`); the architecture formats read the shapes and connectors
 * themselves. The Export dialog, the command palette and `exportSourceFile` all go through
 * `sourceTextFor`, so what the preview shows is byte-for-byte what the file and the clipboard get.
 */

import type { DraftDocument } from '../../document/types';
import { downloadText } from '../download';
import { fileNameFor } from '../project';
import { sequenceSourceFor } from '../sequence';
import { SOURCE_FORMAT_INFO, type SourceFormat } from './formats';
import { c4PlantUmlSource } from './c4plantuml';
import { drawioSource } from './drawio';
import { mermaidFlowchartSource } from './mermaidFlowchart';
import { structurizrSource } from './structurizr';

/** The source text for `document` in `format` — the one function every consumer reads from. */
export function sourceTextFor(document: DraftDocument, format: SourceFormat): string {
  switch (format) {
    case 'mermaid':
    case 'plantuml':
      return sequenceSourceFor(document, format);
    case 'mermaid-flowchart':
      return mermaidFlowchartSource(document);
    case 'c4-plantuml':
      return c4PlantUmlSource(document);
    case 'structurizr':
      return structurizrSource(document);
    case 'drawio':
      return drawioSource(document);
  }
}

export function sourceFileNameFor(document: DraftDocument, format: SourceFormat): string {
  return fileNameFor(document.metadata.title, SOURCE_FORMAT_INFO[format].extension);
}

export function exportSourceFile(document: DraftDocument, format: SourceFormat): Promise<void> {
  return downloadText(sourceTextFor(document, format), sourceFileNameFor(document, format), SOURCE_FORMAT_INFO[format].mime);
}

export { SOURCE_FORMATS, SOURCE_FORMAT_INFO, isSourceFormat, type SourceFamily, type SourceFormat, type SourceFormatInfo } from './formats';
export { c4PlantUmlSource, drawioSource, mermaidFlowchartSource, structurizrSource };
