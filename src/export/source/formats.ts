/**
 * What the source formats are called and written as — data only. Apart from `index.ts` (which carries
 * the writers) so the command palette and the Export dialog's pickers can list the formats without
 * loading Structurizr, draw.io, C4-PlantUML and the sequence engine.
 */

export const MERMAID_EXTENSION = '.mmd';
export const PLANTUML_EXTENSION = '.puml';

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
