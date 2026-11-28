import { describe, expect, it } from 'vitest';
import { escapeMermaidText, mermaidKeyword, messageText, noteText, sanitizeNoteText, sanitizeParticipantName } from '../src/sequence/mermaid';

/**
 * The words of a native sequence, as they are written into the Mermaid text an agent reads and
 * edits: a name, a message or a note must come back as the characters the author typed, and never
 * as a statement, a comment or a directive of Mermaid's own.
 */
describe('writing text into Mermaid sequence source', () => {
  it('declares an actor as one, and every other kind as a participant', () => {
    expect(mermaidKeyword('actor')).toBe('actor');
    expect(mermaidKeyword('participant')).toBe('participant');
    expect(mermaidKeyword('database')).toBe('participant');
    expect(mermaidKeyword('queue')).toBe('participant');
  });

  it('collapses a lone carriage return in a name and a message, not only \\n', () => {
    expect(sanitizeParticipantName('A\rB')).toBe('A B');
    expect(messageText('Go\rnow')).toBe('Go now');
    expect(messageText('Go\r\nnow\nplease')).toBe('Go now please');
  });

  it('writes `;` and `#` in a message as entity codes, so neither ends the statement', () => {
    expect(messageText('Retry #2; then give up')).toBe('Retry #35;2#59; then give up');
  });

  it('escapes tag-shaped text so the renderer cannot strip it', () => {
    expect(messageText('Map<String, Order> & more')).toBe('Map#lt;String, Order#gt; #amp; more');
    expect(sanitizeParticipantName('Cache<Order>')).toBe('Cache#lt;Order#gt;');
  });

  it('writes `%` as an entity, so a label can never carry a directive to the renderer', () => {
    const escaped = escapeMermaidText('100%%{init: {"theme": "dark"}}%%');
    expect(escaped).not.toContain('%%');
    expect(escaped).toBe('100#37;#37;{init: {"theme": "dark"}}#37;#37;');
  });

  it('keeps a literal colon in a message — Mermaid splits on the first colon only', () => {
    expect(messageText('HTTP 200: OK')).toBe('HTTP 200: OK');
  });

  it('leaves a blank message blank: a reply often says nothing', () => {
    expect(messageText('  ')).toBe('');
  });

  it('keeps words that start "wrap:" or "nowrap:", which Mermaid reads as a switch and drops', () => {
    expect(escapeMermaidText('wrap: the gift')).toBe('#119;rap: the gift');
    expect(escapeMermaidText('  NoWrap: please')).toBe('  #78;oWrap: please');
    expect(escapeMermaidText(':wrap: again')).toBe('#58;wrap: again');
    // Only where Mermaid looks for the switch: at the start.
    expect(escapeMermaidText('gift wrap: yes')).toBe('gift wrap: yes');
  });

  it('writes quotes and brackets in a name as they are — Mermaid shows quotes literally', () => {
    expect(sanitizeParticipantName('Service (2)')).toBe('Service (2)');
    expect(sanitizeParticipantName('The "Gateway"')).toBe('The "Gateway"');
  });

  it('keeps backslashes, colons and quotes in a name, but still guards statement-ending characters and newlines', () => {
    expect(sanitizeParticipantName('C:\\Users\\"Bob"')).toBe('C:\\Users\\"Bob"');
    expect(sanitizeParticipantName('Cart; #1\nsvc')).toBe('Cart#59; #35;1 svc');
  });

  it('never writes a participant with no name', () => {
    expect(sanitizeParticipantName('  \n ')).toBe('Participant');
  });

  it('wraps a long note into <br/>-separated lines instead of one very wide box', () => {
    const long =
      'Compensation is event-driven too: Payment refunds and publishes Payment Refunded; Order reacts to that in turn.';
    const segments = noteText(long).split('<br/>');

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) expect(segment.length).toBeLessThanOrEqual(60);
    // A colon is text once the note's own delimiter has passed; only `;` needs its entity.
    expect(segments.join(' ')).toBe(long.replace(/;/g, '#59;'));
  });

  it('collapses a multi-line code note into one line via <br/>, escaping HTML-sensitive characters', () => {
    // Mermaid entity codes, not HTML entities: `&lt;`'s own `;` (and the code's `;`) would end the
    // statement mid-note.
    expect(noteText('if (a < b && b > c) {\n  retry();\n}', true)).toBe('if (a #lt; b #amp;#amp; b #gt; c) {<br/>retry()#59;<br/>}');
  });

  it('leaves a blank note blank, and names one that has to say something', () => {
    expect(noteText(' \n ')).toBe('');
    expect(sanitizeNoteText(' \n ')).toBe('Note');
    expect(sanitizeNoteText('another interaction')).toBe('another interaction');
  });

  it('does not truncate a very long message', () => {
    const long = 'word '.repeat(200).trim();
    expect(messageText(long)).toBe(long);
  });
});
