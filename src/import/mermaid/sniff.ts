/**
 * Whether pasted or dropped text is a Mermaid flowchart — and nothing more. Kept apart from the
 * reader (`parse.ts`) so the editor and the Library, which ask this of every foreign paste and file,
 * don't carry the whole parser in their first chunk; the reader loads when a flowchart actually lands.
 */

/** Text past this is not a flowchart anyone drew by hand; refused before any line is read. */
export const MERMAID_TEXT_LIMIT = 512 * 1024;

export const HEADER = /^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?\s*$/i;
const FENCE = /```\s*mermaid[^\n]*\n([\s\S]*?)```/gi;
export const FRONT_MATTER = /^\s*---\s*\n([\s\S]*?)\n---\s*\n/;

/**
 * The flowchart inside a Markdown document, when the text is one; else the text itself. The first
 * fenced block that is a flowchart: a README often opens with a sequence diagram, and taking the
 * first block refused the whole file over it.
 */
export function unfence(text: string): string {
  const blocks = [...text.matchAll(FENCE)].map((match) => match[1]!);
  if (blocks.length === 0) return text;
  return blocks.find(isFlowchart) ?? blocks[0]!;
}

/** How many more fenced Mermaid blocks a Markdown document holds than the one `unfence` reads. */
export function otherFencedBlocks(text: string): number {
  return Math.max(0, [...text.matchAll(FENCE)].length - 1);
}

export function stripFrontMatter(text: string): string {
  return text.replace(FRONT_MATTER, '');
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

/** Whether text reads as a Mermaid flowchart — cheap enough for every paste. */
export function looksLikeMermaid(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0 || text.length > MERMAID_TEXT_LIMIT) return false;
  return isFlowchart(unfence(text));
}
