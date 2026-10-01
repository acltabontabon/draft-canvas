/**
 * Every text a diagram can be exported as, under one id each. Two families: the sequence formats
 * read a Flow's telling (`../sequence.ts`); the architecture formats read the shapes and connectors
 * themselves. The Export dialog, the command palette and `exportSourceFile` all go through
 * `sourceTextFor`, so what the preview shows is byte-for-byte what the file and the clipboard get.
 */

import type { DraftDocument } from '../../document/types';
import { downloadText } from '../download';
import { fileNameFor } from '../project';
import { MERMAID_EXTENSION, PLANTUML_EXTENSION, sequenceSourceFor } from '../sequence';
import { c4PlantUmlSource } from './c4plantuml';
import { drawioSource } from './drawio';
import { mermaidFlowchartSource } from './mermaidFlowchart';
import { structurizrSource } from './structurizr';

export const SOURCE_FORMATS = ['mermaid', 'plantuml', 'mermaid-flowchart', 'c4-plantuml', 'structurizr', 'drawio'] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

/** `'sequence'` reads a Flow and needs one; `'architecture'` reads the diagram and never does. */
export type SourceFamily = 'sequence' | 'architecture';

export interface SourceFormatInfo {
  id: SourceFormat;
  family: SourceFamily;
  /** The format's name as the dialog and the palette show it. */
  label: string;
  /** Its name in the Export dialog's format picker, where a family's formats sit side by side —
   *  short enough that four fit on one line ("Structurizr DSL" wrapped mid-pill there). */
  pick: string;
  /** The file tile's badge — the extension, upper-cased, the way the other tiles read. */
  badge: string;
  extension: string;
  mime: string;
}

export const SOURCE_FORMAT_INFO: Record<SourceFormat, SourceFormatInfo> = {
  mermaid: { id: 'mermaid', family: 'sequence', label: 'Mermaid', pick: 'Mermaid', badge: 'MMD', extension: MERMAID_EXTENSION, mime: 'text/plain' },
  plantuml: { id: 'plantuml', family: 'sequence', label: 'PlantUML', pick: 'PlantUML', badge: 'PUML', extension: PLANTUML_EXTENSION, mime: 'text/plain' },
  'mermaid-flowchart': { id: 'mermaid-flowchart', family: 'architecture', label: 'Mermaid flowchart', pick: 'Mermaid', badge: 'MMD', extension: MERMAID_EXTENSION, mime: 'text/plain' },
  'c4-plantuml': { id: 'c4-plantuml', family: 'architecture', label: 'C4-PlantUML', pick: 'C4-PlantUML', badge: 'PUML', extension: PLANTUML_EXTENSION, mime: 'text/plain' },
  structurizr: { id: 'structurizr', family: 'architecture', label: 'Structurizr DSL', pick: 'Structurizr', badge: 'DSL', extension: '.dsl', mime: 'text/plain' },
  drawio: { id: 'drawio', family: 'architecture', label: 'draw.io', pick: 'draw.io', badge: 'DRAWIO', extension: '.drawio', mime: 'application/xml' },
};

export function isSourceFormat(value: unknown): value is SourceFormat {
  return typeof value === 'string' && (SOURCE_FORMATS as readonly string[]).includes(value);
}

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

export { c4PlantUmlSource, drawioSource, mermaidFlowchartSource, structurizrSource };
