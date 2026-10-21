/**
 * A Text element's words without their Markdown: what a screen reader says for it, what search
 * matches and the Outline lists, and what formats without Markdown (draw.io, Mermaid, PlantUML)
 * receive. Line-based and dependency-free, because the file model imports nothing that renders —
 * the full parser lives in `render/text/markdown.ts`. Reading, not rendering: it keeps every word
 * and drops only the punctuation that would be formatting.
 */
export function plainTextOfMarkdown(source: string): string {
  if (!/[*_`~=[\]#>|\\!-]|^\s*\d+[.)]\s/m.test(source)) return source;
  const lines: string[] = [];
  let fenced = false;
  for (const raw of source.split(/\r\n|\r|\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      lines.push(raw);
      continue;
    }
    let line = raw
      .replace(/^\s*(>\s?)+/, '')
      .replace(/^\s*\[!(note|tip|important|warning|caution)\]\s*$/i, '')
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, '$1')
      .replace(/^(\s*)[-*+]\s+/, '$1')
      .replace(/^\s*([-*_=]\s*){3,}$/, '');
    // A table's delimiter row draws nothing; its cells read as a list.
    if (/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().slice(1, -1).split('|').map((cell) => cell.trim()).join(', ');
    line = line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[((?:\\.|[^[\]\\])+)\]\{\.[a-z]+\}/g, '$1')
      .replace(/(\*\*|__|~~|==)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, '$1$3')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\\([!-/:-@[-`{-~])/g, '$1');
    lines.push(line);
  }
  return lines.join('\n').replace(/^\n+|\n+$/g, '');
}
