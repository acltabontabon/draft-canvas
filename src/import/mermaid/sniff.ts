/**
 * Whether pasted or dropped text is a Mermaid flowchart — and nothing more. Kept apart from the
 * reader (`parse.ts`) so the editor and the Library, which ask this of every foreign paste and file,
 * don't carry the whole parser in their first chunk; the reader loads when a flowchart actually lands.
 */

/** What an imported flowchart is called when neither its front matter nor its file name says. */
export const DEFAULT_IMPORT_TITLE = 'Imported diagram';

/** Text past this is not a flowchart anyone drew by hand; refused before any line is read. */
export const MERMAID_TEXT_LIMIT = 512 * 1024;

export const HEADER = /^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?\s*$/i;
/**
 * A fence opens and closes at the start of a line, as Markdown has it: one closed by three backticks
 * anywhere ended a block at a message saying "returns ```json".
 */
const FENCE = /^[ \t]*```[ \t]*mermaid[^\n]*\n([\s\S]*?)^[ \t]*```/gim;
export const FRONT_MATTER = /^\s*---\s*\n([\s\S]*?)\n---\s*\n/;

/**
 * The flowchart inside a Markdown document, when the text is one; else the text itself. The first
 * fenced block that is a flowchart: a README often opens with a sequence diagram, and taking the
 * first block refused the whole file over it.
 */
export function unfence(text: string): string {
  const blocks = [...text.matchAll(FENCE)].map((match) => match[1]!);
  if (blocks.length === 0) return text;
  return blocks.find(isFlowchart) ?? blocks.find(isSequenceDiagram) ?? blocks[0]!;
}

/** How many more fenced Mermaid blocks a Markdown document holds than the one `unfence` reads. */
export function otherFencedBlocks(text: string): number {
  return Math.max(0, [...text.matchAll(FENCE)].length - 1);
}

export function stripFrontMatter(text: string): string {
  return text.replace(FRONT_MATTER, '');
}

/**
 * The `title:` a front-matter block gives, read a line at a time. `title\s*:\s*(.+?)\s*$` over the
 * whole block backtracked over every split of a long run of spaces: 2 s at 40 KB.
 */
export function frontMatterTitle(text: string): string | undefined {
  const front = FRONT_MATTER.exec(text)?.[1];
  for (const line of front?.split('\n') ?? []) {
    const named = /^\s*title\s*:/.exec(line);
    const title = named ? line.slice(named[0].length).trim() : '';
    if (title) return title;
  }
  return undefined;
}

function firstStatement(line: string): string {
  const semicolon = line.indexOf(';');
  return semicolon === -1 ? line : line.slice(0, semicolon);
}

function isFlowchart(source: string): boolean {
  for (const line of stripFrontMatter(source).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('%%')) continue;
    return HEADER.test(firstStatement(trimmed));
  }
  return false;
}

function isSequenceDiagram(source: string): boolean {
  for (const line of stripFrontMatter(source).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('%%')) continue;
    return /^sequenceDiagram\s*$/i.test(firstStatement(trimmed));
  }
  return false;
}

/** Whether text reads as a Mermaid sequence diagram: imported as a sequence that can be edited on the canvas. */
export function looksLikeMermaidSequence(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0 || text.length > MERMAID_TEXT_LIMIT) return false;
  const body = unfence(text);
  return !isFlowchart(body) && isSequenceDiagram(body);
}

/** Whether text reads as Mermaid this app imports — a flowchart or a sequence diagram — cheap enough for every paste. */
export function looksLikeMermaid(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0 || text.length > MERMAID_TEXT_LIMIT) return false;
  const body = unfence(text);
  return isFlowchart(body) || isSequenceDiagram(body);
}
