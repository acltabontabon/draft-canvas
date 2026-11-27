/**
 * A Mermaid `sequenceDiagram`, read as a sequence that can be edited on the canvas.
 *
 * What a sequence here can hold is kept as it was written: participants and actors, boxes, the
 * arrows (and `+`/`-` for work starting and ending), `create` and `destroy`, notes, and `alt`,
 * `opt`, `loop`, `par`, `critical` and `break`. What it cannot — numbering, a tinted `rect`, links
 * on a participant — is named in `unsupported`, never dropped in silence, and the messages inside
 * a `rect` stay where they were.
 *
 * Nothing is inferred: Mermaid says when work starts and ends, so a call here starts work only
 * where the text said so. A dashed reply is taken to answer the latest call still waiting for one
 * between the same two, which is how the text is read by anyone looking at it.
 */
import { createId } from '../../document/ids';
import { LIMITS } from '../../document/limits';
import { normalizeSequence } from '../../document/validateSequence';
import type { DraftSequence, SeqFragment, SeqGroup, SeqItem, SeqMessage, SeqMessageKind, SeqNote, SeqOperand, SeqOperator, SeqParticipant } from '../../document/types';
import { isCssColour } from './cssColour';
import { frontMatterTitle, MERMAID_TEXT_LIMIT, otherFencedBlocks, stripFrontMatter, unfence } from './sniff';

export type MermaidSequenceParse =
  | {
      ok: true;
      title: string;
      sequence: DraftSequence;
      unsupported: string[];
      /** By participant id, the name it was written under in the text (`api` in `participant api as Checkout API`). */
      written: Map<string, string>;
    }
  | { ok: false; error: string };

/** The title a sequence gets when its text gives none. */
export const UNTITLED_SEQUENCE = 'Imported sequence';

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', nbsp: ' ' };

/** Mermaid's entity codes (`#35;`, `#lt;`) as the characters they stand for, and `<br/>` as a line break. */
function decode(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    // One pass: the decoded hash in `#35;lt#59;` is literal text, never a second entity.
    .replace(/#(\d{1,7}|[a-z]+);/gi, (whole, code: string) => {
      const name = code.toLowerCase();
      if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name]!;
      const value = Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    })
    .trim();
}

/**
 * A comment is a line that starts `%%`. (A directive, `%%{…}%%`, is one too: it configures a renderer
 * this is not.) A `%%` later in a line is text — Mermaid keeps `A->>B: 100%% done` whole — and cutting
 * there read it as "100".
 */
const withoutComment = (line: string): string => (line.trimStart().startsWith('%%') ? '' : line);

/*
 * Messages, declarations and notes are read by hand, never by one pattern over the whole line. The
 * patterns this replaced trimmed with `\s*` beside a lazy group (`(.+?)\s*:`), so a run of spaces that
 * no arrow, colon or `as` ended was backtracked over at every split: 2 s for a 40 KB line, more than
 * eight minutes for one near the 512 KB cap, on the main thread of a paste.
 */

/** `->>`, `-->>`, `-)`, `--)`, `-x`, `--x`, `->`, `-->`, `<<->>`, `<<-->>`: longest first, so `-->>` is not read as `-->`. */
// Match arrows in the context of a message. A bare `-->` also ends an HTML comment.
const ARROW = /<<-->>|<<->>|-->>|--\)|--x|-->|->>|-\)|-x|->/g;

interface Said {
  from: string;
  arrow: string;
  /** `+` or `-` straight after the arrow. */
  mark: string;
  to: string;
  /** Everything after the first colon; absent without one. */
  text?: string;
}

/** `A->>+B: text`: the sender up to the first arrow, an optional `+`/`-`, the receiver up to the first colon, the text after it. */
function readMessage(line: string): Said | null {
  // A sender is at least one character.
  ARROW.lastIndex = 1;
  const arrow = ARROW.exec(line);
  if (!arrow) return null;
  const from = line.slice(0, arrow.index).trim();
  let rest = line.slice(arrow.index + arrow[0].length).trimStart();
  let mark = '';
  if (rest.startsWith('+') || rest.startsWith('-')) {
    mark = rest[0]!;
    rest = rest.slice(1).trimStart();
  }
  const colon = rest.indexOf(':');
  const to = (colon === -1 ? rest : rest.slice(0, colon)).trimEnd();
  if (!from || !to) return null;
  return colon === -1 ? { from, arrow: arrow[0], mark, to } : { from, arrow: arrow[0], mark, to, text: rest.slice(colon + 1) };
}

interface Declared {
  create: boolean;
  actor: boolean;
  name: string;
  label?: string;
  /** Written with Mermaid's `@{ … }` configuration. */
  configured: boolean;
}

const DECLARES = /^(create\s+)?(participant|actor)\s+/i;
const AS = /\sas\s/i;

/** `participant A`, `actor A as Name`, `create participant A@{ "type": "database" } as Name`. */
function readDeclared(line: string): Declared | null {
  const head = DECLARES.exec(line);
  if (!head) return null;
  const body = line.slice(head[0].length);
  const declared = { create: head[1] !== undefined, actor: head[2]!.toLowerCase() === 'actor' };
  const open = body.indexOf('@{');
  const close = body.lastIndexOf('}');
  if (open > 0 && close > open) {
    // Nothing after the configuration, or ` as Name`.
    const after = body.slice(close + 1);
    const spoken = after.trimStart();
    if (!spoken) return { ...declared, name: body.slice(0, open).trimEnd(), configured: true };
    if (spoken.length < after.length && /^as\s/i.test(spoken)) return { ...declared, name: body.slice(0, open).trimEnd(), label: spoken.slice(2).trimStart(), configured: true };
  }
  const as = AS.exec(body);
  if (!as) return { ...declared, name: body, configured: false };
  return { ...declared, name: body.slice(0, as.index).trimEnd(), label: body.slice(as.index + as[0].length).trimStart(), configured: false };
}

/** Mermaid's own split of what follows `box` (`parseBoxData`): a colour, then the name. */
const BOX = /^((?:rgba?|hsla?)\s*\(.*\)|\w*)(.*)$/;

/**
 * A box's name, read as Mermaid reads it: the first word (or an `rgb(…)`/`hsl(…)` up to the line's last
 * `)`) is the colour when a browser takes it for one, and the name is what follows; when it is not,
 * all of it is the name. So `box Aqua Payments` is named "Payments" and `box Aqua` has none, while
 * `box Bluebird Team`, `box transparent Blue team` and `box rgb(1,2,3) Payments (EU)` (which no
 * browser reads as a colour) keep every word. Mermaid takes `#` for the start of a comment, so
 * `box #E3F2FD Backend` has no name there; here a hex colour is still the colour, and the name is kept.
 */
function boxName(rest: string): string {
  const hex = /^#[0-9a-f]{3,8}(?:\s+|$)/i.exec(rest);
  if (hex) return rest.slice(hex[0].length);
  const [, colour = '', named = ''] = BOX.exec(rest) ?? [];
  return isCssColour(colour) ? named.trim() : rest;
}

const NOTE_PLACE = /^(over|left of|right of)\s+/i;

/** `over A,B: text`, `left of A: text`, `right of A: text` — what follows the word `Note`. */
function readNote(rest: string): { where: string; names: string; text: string } | null {
  const place = NOTE_PLACE.exec(rest);
  if (!place) return null;
  const body = rest.slice(place[0].length);
  const colon = body.indexOf(':');
  const names = colon === -1 ? '' : body.slice(0, colon).trimEnd();
  return names ? { where: place[1]!.toLowerCase(), names, text: body.slice(colon + 1) } : null;
}

interface Block {
  /** `flat`: a frame that is not kept — nested past what a sequence holds — whose messages stay in the frame around it. */
  kind: 'fragment' | 'flat' | 'box' | 'rect';
  /** A fragment's or a flat frame's: whose `else`, `and` or `option` it takes. */
  operator?: SeqOperator;
  fragment?: SeqFragment;
  operand?: SeqOperand;
  /** A fragment's or a flat frame's: where what is said inside it goes. */
  items?: SeqItem[];
  group?: SeqGroup;
  /** The calls still waiting for a reply when the fragment began: what each of its branches starts from. */
  waiting?: SeqMessage[];
  /** Calls answered in a branch already read. Another branch may answer them again — it is the same call, taken another way. */
  answered?: Set<SeqMessage>;
}

// `par_over` is Mermaid's `par` drawn over the participants; read as anything else, its `end` closed the frame around it.
const OPERATORS: Record<string, SeqOperator> = { alt: 'alt', opt: 'opt', loop: 'loop', par: 'par', par_over: 'par', critical: 'critical', break: 'break' };
const NEXT_BRANCH: Record<string, SeqOperator> = { else: 'alt', and: 'par', option: 'critical' };

export function parseMermaidSequence(text: string, participantIds?: ReadonlyMap<string, string>): MermaidSequenceParse {
  if (typeof text !== 'string') return { ok: false, error: 'That is not text.' };
  if (text.length > MERMAID_TEXT_LIMIT) return { ok: false, error: `That text is ${(text.length / 1024).toFixed(0)} KB, which is more than a sequence diagram anyone wrote by hand.` };
  const unsupported = new Set<string>();
  const unfenced = unfence(text);
  const others = otherFencedBlocks(text);
  if (others > 0) unsupported.add(others === 1 ? 'another Mermaid block in the file (not imported)' : `${others} other Mermaid blocks in the file (not imported)`);
  let title = frontMatterTitle(unfenced);
  const lines = stripFrontMatter(unfenced)
    .split(/\r?\n/)
    .map((line) => withoutComment(line).trim())
    .filter((line) => line !== '');
  if (!/^sequenceDiagram\b/i.test(lines[0] ?? '')) return { ok: false, error: 'That text does not start with "sequenceDiagram".' };

  const participants: SeqParticipant[] = [];
  const byName = new Map<string, SeqParticipant>();
  const groups: SeqGroup[] = [];
  const root: SeqItem[] = [];
  const stack: Block[] = [];
  /** The fragments and flat frames open, innermost last: where what is said goes, and whose branch an `else` starts. */
  const frames: Block[] = [];
  /** The fragments open — never more than a sequence nests. */
  const fragments: Block[] = [];
  /** The box being read: the first one opened, as Mermaid has no box inside a box. */
  let box: SeqGroup | undefined;
  /** Participants announced by `create`, waiting for the message that makes them; and by `destroy`, for the one that ends them. */
  const toCreate = new Set<string>();
  const toDestroy = new Set<string>();
  let calls: SeqMessage[] = [];
  let last: SeqMessage | null = null;

  /*
   * What one sequence keeps (`normalizeSequence`) is counted as it is read, and nothing past it is
   * built: 40 participants, 600 messages, notes and frames, and frames 8 deep. Built in full, 50,000
   * nested frames took 12 s and 30,000 calls with as many unanswered replies 14 s, every line walking
   * all that was opened or said above it, only for the reader to drop nearly all of it.
   */
  const outside = new Set<string>();
  let kept = 0;
  let beyond = 0;
  const keeps = (...ids: string[]): boolean => {
    if (kept >= LIMITS.maxSequenceItems || ids.some((id) => outside.has(id))) {
      beyond += 1;
      return false;
    }
    kept += 1;
    return true;
  };

  const here = (): SeqItem[] => frames[frames.length - 1]?.items ?? root;
  const open = (block: Block) => {
    stack.push(block);
    if (block.items) frames.push(block);
    if (block.kind === 'fragment') fragments.push(block);
  };

  const participant = (rawName: string, label?: string, actor = false): SeqParticipant => {
    const key = rawName.trim();
    const known = byName.get(key);
    if (known) {
      if (label !== undefined) known.name = label;
      if (actor) Object.assign(known, { type: 'actor', actorKind: 'human' });
      return known;
    }
    const id = participantIds?.get(key) ?? createId('sp');
    const made: SeqParticipant = actor
      ? { id, name: label ?? decode(key), type: 'actor', actorKind: 'human' }
      : { id, name: label ?? decode(key), type: 'service', serviceKind: 'generic' };
    byName.set(key, made);
    if (participants.length < LIMITS.maxSequenceParticipants) {
      participants.push(made);
      box?.participantIds.push(made.id);
    } else {
      outside.add(made.id);
      beyond += 1;
    }
    return made;
  };

  for (const line of lines.slice(1)) {
    const word = (line.split(/\s+/)[0] ?? '').toLowerCase();
    const rest = line.slice(word.length).trim();

    // One diagram per text: what an export of several wrote before it wrote Markdown, read on into one.
    if (word === 'sequencediagram') {
      unsupported.add('another sequence diagram in the text (not imported)');
      break;
    }

    // `title Checkout`, and Mermaid's older `title: Checkout`.
    if (word === 'title' || word === 'title:') {
      title = decode(rest.replace(/^:\s*/, ''));
      continue;
    }
    if (word === 'autonumber') {
      unsupported.add('message numbering (autonumber)');
      continue;
    }
    if (word === 'link' || word === 'links' || word === 'properties' || word === 'details') {
      unsupported.add('links and properties on a participant');
      continue;
    }

    const declared = readDeclared(line);
    if (declared) {
      const made = participant(declared.name, declared.label ? decode(declared.label) : undefined, declared.actor);
      if (declared.configured) unsupported.add('participant configuration (type or alias): the participant is kept');
      if (declared.create) toCreate.add(made.id);
      continue;
    }
    if (word === 'destroy' && rest) {
      toDestroy.add(participant(rest).id);
      continue;
    }

    if (word === 'box') {
      const group: SeqGroup = { id: createId('sg'), name: decode(boxName(rest)), participantIds: [] };
      groups.push(group);
      box ??= group;
      open({ kind: 'box', group });
      continue;
    }
    if (word === 'rect') {
      unsupported.add('a tinted background (rect): what was inside it is kept');
      open({ kind: 'rect' });
      continue;
    }
    // Own keys only: a line that starts `constructor` or `__proto__` is not a fragment.
    if (Object.hasOwn(OPERATORS, word)) {
      const operator = OPERATORS[word]!;
      // Nested deeper than a sequence keeps, the frame is opened out as a file this deep is: it goes,
      // and what it says stays in the frame around it.
      if (fragments.length >= LIMITS.maxSequenceDepth) {
        beyond += 1;
        open({ kind: 'flat', operator, items: here() });
        continue;
      }
      if (!keeps()) {
        open({ kind: 'flat', operator, items: here() });
        continue;
      }
      const operand: SeqOperand = { id: createId('so'), items: [] };
      const guard = decode(rest);
      if (guard) operand.guard = guard;
      const fragment: SeqFragment = { id: createId('sf'), t: 'fragment', operator, operands: [operand] };
      here().push(fragment);
      open({ kind: 'fragment', operator, fragment, operand, items: operand.items, waiting: calls.slice(), answered: new Set() });
      continue;
    }
    if (Object.hasOwn(NEXT_BRANCH, word)) {
      const frame = frames[frames.length - 1];
      if (!frame || frame.operator !== NEXT_BRANCH[word]) {
        unsupported.add(`"${word}" outside the block it belongs to`);
      } else if (frame.fragment) {
        const operand: SeqOperand = { id: createId('so'), items: [] };
        const guard = decode(rest);
        if (guard) operand.guard = guard;
        frame.fragment.operands.push(operand);
        frame.operand = operand;
        frame.items = operand.items;
        // Each branch is another way the same moment can go: it starts from what was waiting when
        // the fragment began, so "replies in either branch" is one call answered either way.
        calls = (frame.waiting ?? []).slice();
      }
      continue;
    }
    if (word === 'end') {
      const closed = stack.pop();
      if (closed?.items) frames.pop();
      if (closed?.kind === 'fragment') fragments.pop();
      if (closed?.group === box) box = undefined;
      // Answered in any branch is answered.
      if (closed?.kind === 'fragment' && closed.waiting) calls = closed.waiting.filter((call) => !closed.answered?.has(call));
      continue;
    }

    if (word === 'activate' || word === 'deactivate') {
      const who = participant(rest).id;
      // Mermaid says these on their own line; here they belong to the message beside them.
      if (word === 'activate' && last && last.to === who) last.activate = true;
      else if (word === 'deactivate' && last && last.from === who) last.deactivate = true;
      else unsupported.add('work that starts or ends without a message beside it');
      continue;
    }

    if (word === 'note') {
      const placed = readNote(rest);
      if (placed) {
        const over = [...new Set(placed.names.split(',').map((name) => participant(name).id))].filter((id) => !outside.has(id));
        if (over.length === 0) beyond += 1;
        else if (keeps()) {
          const note: SeqNote = { id: createId('sn'), t: 'note', text: decode(placed.text), over };
          if (placed.where === 'left of') note.side = 'left';
          if (placed.where === 'right of') note.side = 'right';
          here().push(note);
        }
        continue;
      }
    }

    const said = readMessage(line);
    if (said) {
      const from = participant(said.from);
      const arrow = said.arrow;
      const to = participant(said.to);
      if (arrow.startsWith('<<')) unsupported.add('a message both ways at once: drawn as one call');
      if (arrow.endsWith('x') && !toDestroy.has(to.id) && !toDestroy.has(from.id)) unsupported.add('a lost message (-x): drawn as a call');
      let kind: SeqMessageKind = arrow === '-)' || arrow === '--)' ? 'async' : arrow.startsWith('--') || arrow === '<<-->>' ? 'reply' : 'sync';
      const message: SeqMessage = { id: createId('sm'), t: 'message', from: from.id, to: to.id, kind, label: decode(said.text ?? '') };
      if (toCreate.delete(to.id)) kind = 'create';
      else if (toDestroy.delete(to.id)) kind = 'destroy';
      else if (toDestroy.delete(from.id)) unsupported.add('a message that destroys its sender: the message is kept');
      message.kind = kind;
      if (said.mark === '+') message.activate = true;
      if (said.mark === '-') message.deactivate = true;
      last = message;
      if (!keeps(from.id, to.id)) continue;
      if (kind === 'reply') {
        // The latest call between these two, the other way, that nothing has answered yet.
        const at = calls.findLastIndex((call) => call.from === to.id && call.to === from.id);
        if (at >= 0) {
          const call = calls.splice(at, 1)[0]!;
          message.replyTo = call.id;
          // Mermaid counts work straight down the text and refuses to end the same work in a second
          // branch, so a reply there is written without its `-`. Where an earlier branch already
          // ended this call's work, this one does too.
          if (call.activate && fragments.some((block) => block.answered?.has(call))) message.deactivate = true;
          for (const block of fragments) block.answered?.add(call);
        }
      } else if (kind === 'sync' && from.id !== to.id) {
        calls.push(message);
      }
      here().push(message);
      continue;
    }

    unsupported.add(`a line it couldn’t read: “${line.length > 40 ? `${line.slice(0, 40)}…` : line}”`);
  }

  const read = normalizeSequence({ participants, groups, items: root });
  const dropped = read.dropped + beyond;
  if (dropped > 0) unsupported.add(`${dropped} part${dropped === 1 ? '' : 's'} beyond what one sequence holds`);
  if (read.sequence.participants.length === 0) return { ok: false, error: 'There is nobody in that sequence diagram.' };
  const standing = new Set(read.sequence.participants.map((entry) => entry.id));
  const written = new Map([...byName].filter(([, entry]) => standing.has(entry.id)).map(([name, entry]) => [entry.id, name]));
  return { ok: true, title: title?.trim() || UNTITLED_SEQUENCE, sequence: read.sequence, unsupported: [...unsupported], written };
}
