/**
 * Takeaways as text you can paste somewhere else.
 *
 * The same separation `export/sequence.ts` already makes: this produces a string and nothing
 * more — who copies it, and whether it goes to the clipboard or a file, is somebody else's job.
 *
 * GitHub task-list syntax (`- [ ]`) on purpose. It becomes real checkboxes in GitHub and Jira,
 * renders as a clean list in Slack, Teams and Confluence, and where none of that is true it is
 * still exactly what a person would have typed by hand. No summarising, no rewording: every word
 * here was written by somebody in the meeting.
 */

import { isEmpty, type Takeaways } from './collect';

/**
 * Markdown is a format with syntax, and a note's text is arbitrary: a decision that happens to
 * read "use * for the wildcard" must not come out italic, and one starting "1. pick a broker"
 * must not silently become a numbered list.
 *
 * Escaped conservatively — only the characters that change the meaning of a line when they lead
 * it, plus the inline pairs — because over-escaping a line somebody is about to read is as bad
 * as under-escaping it.
 */
function escapeMarkdown(text: string): string {
  // A note is multi-line free text; a list item is one line. Collapsing first is what stops the
  // second line of a decision from landing outside the bullet it belongs to.
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\`*_[\]<>])/g, '\\$1')
    .replace(/^([-+#>])/, '\\$1')
    // `1.` and `1)` are both ordered-list markers, and inside a bullet either one starts a nested list.
    .replace(/^(\d+)([.)])/, '$1\\$2');
}

/** "Who owns retry (Payments API)" — the room a note was written in, when it wasn't this one. */
function withRoom(text: string, room: string | undefined): string {
  return room ? `${text} _(${escapeMarkdown(room)})_` : text;
}

export function takeawaysMarkdown(takeaways: Takeaways, title: string): string {
  if (isEmpty(takeaways)) return '';

  const lines: string[] = [`## ${escapeMarkdown(title.trim() || 'Untitled canvas')}`];

  const section = (heading: string, rows: string[]) => {
    if (rows.length === 0) return;
    lines.push('', `### ${heading}`, ...rows);
  };

  section(
    'Decisions',
    takeaways.decisions.map((note) => `- ${withRoom(escapeMarkdown(note.text), note.target.room)}`),
  );

  section(
    'Open questions',
    takeaways.questions.map((note) => `- ${withRoom(escapeMarkdown(note.text), note.target.room)}`),
  );

  section(
    'Actions',
    takeaways.actions.map((entry) => {
      const box = entry.action.done ? '[x]' : '[ ]';
      // The architecture it came from travels with it. Pasted into a ticket a week later, "check
      // the timeout" is useless on its own and obvious with the connector's name after it.
      const context = entry.context ? ` — ${escapeMarkdown(entry.context.label)}` : '';
      return `- ${box} ${escapeMarkdown(entry.action.text)}${context}`;
    }),
  );

  // A trailing newline, like every other text file this app writes.
  return `${lines.join('\n')}\n`;
}
