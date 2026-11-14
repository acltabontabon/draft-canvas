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
import { normalizeSequence } from '../../document/validateSequence';
import type { DraftSequence, SeqFragment, SeqGroup, SeqItem, SeqMessage, SeqMessageKind, SeqNote, SeqOperand, SeqOperator, SeqParticipant } from '../../document/types';
import { FRONT_MATTER, MERMAID_TEXT_LIMIT, otherFencedBlocks, stripFrontMatter, unfence } from './sniff';

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
    .replace(/#(\d{1,7});/g, (whole, code: string) => {
      const value = Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    })
    .replace(/#([a-z]+);/gi, (whole, name: string) => (Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()]! : whole))
    .trim();
}

/** A comment runs from `%%` to the end of the line. (A directive, `%%{…}%%`, is one too: it configures a renderer this is not.) */
const withoutComment = (line: string): string => {
  const at = line.indexOf('%%');
  return at === -1 ? line : line.slice(0, at);
};

/** `->>`, `-->>`, `-)`, `--)`, `-x`, `--x`, `->`, `-->`, `<<->>`, `<<-->>`: longest first, so `-->>` is not read as `-->`. */
// Match arrows in the context of a message. A bare `-->` also ends an HTML comment.
const MESSAGE = /^(.+?)\s*(<<-->>|<<->>|-->>|--\)|--x|-->|->>|-\)|-x|->)\s*([+-]?)\s*(.+?)\s*(?::\s*(.*))?$/;

interface Block {
  kind: 'fragment' | 'box' | 'rect';
  fragment?: SeqFragment;
  operand?: SeqOperand;
  group?: SeqGroup;
  /** The calls still waiting for a reply when the fragment began: what each of its branches starts from. */
  waiting?: SeqMessage[];
  /** Calls answered in a branch already read. Another branch may answer them again — it is the same call, taken another way. */
  answered?: Set<SeqMessage>;
}

const OPERATORS: Record<string, SeqOperator> = { alt: 'alt', opt: 'opt', loop: 'loop', par: 'par', critical: 'critical', break: 'break' };
const NEXT_BRANCH: Record<string, SeqOperator> = { else: 'alt', and: 'par', option: 'critical' };

export function parseMermaidSequence(text: string, participantIds?: ReadonlyMap<string, string>): MermaidSequenceParse {
  if (typeof text !== 'string') return { ok: false, error: 'That is not text.' };
  if (text.length > MERMAID_TEXT_LIMIT) return { ok: false, error: `That text is ${(text.length / 1024).toFixed(0)} KB, which is more than a sequence diagram anyone wrote by hand.` };
  const unsupported = new Set<string>();
  const unfenced = unfence(text);
  const others = otherFencedBlocks(text);
  if (others > 0) unsupported.add(others === 1 ? 'another Mermaid block in the file (not imported)' : `${others} other Mermaid blocks in the file (not imported)`);
  let title = /^\s*title\s*:\s*(.+?)\s*$/m.exec(FRONT_MATTER.exec(unfenced)?.[1] ?? '')?.[1];
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
  /** Participants announced by `create`, waiting for the message that makes them; and by `destroy`, for the one that ends them. */
  const toCreate = new Set<string>();
  const toDestroy = new Set<string>();
  let calls: SeqMessage[] = [];
  let last: SeqMessage | null = null;

  const here = (): SeqItem[] => {
    for (let at = stack.length - 1; at >= 0; at -= 1) {
      const block = stack[at]!;
      if (block.kind === 'fragment') return block.operand!.items;
    }
    return root;
  };
  const box = (): SeqGroup | undefined => stack.find((block) => block.kind === 'box')?.group;

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
    participants.push(made);
    box()?.participantIds.push(made.id);
    return made;
  };

  for (const line of lines.slice(1)) {
    const word = (line.split(/\s+/)[0] ?? '').toLowerCase();
    const rest = line.slice(word.length).trim();

    if (word === 'title') {
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

    const configured = /^(create\s+)?(participant|actor)\s+(.+?)\s*@\{(.*)\}(?:\s+as\s+(.+))?$/i.exec(line);
    const declares = configured ?? /^(create\s+)?(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i.exec(line);
    if (declares) {
      const label = declares[configured ? 5 : 4];
      const made = participant(declares[3]!, label ? decode(label) : undefined, declares[2]!.toLowerCase() === 'actor');
      if (configured) unsupported.add('participant configuration (type or alias): the participant is kept');
      if (declares[1]) toCreate.add(made.id);
      continue;
    }
    if (word === 'destroy' && rest) {
      toDestroy.add(participant(rest).id);
      continue;
    }

    if (word === 'box') {
      // `box Aqua Group name`, `box rgb(1,2,3) Name`, `box transparent Name`, or just `box Name`.
      const named = rest.replace(/^(?:transparent|rgba?\([^)]*\)|#[0-9a-f]{3,8})\s*/i, '');
      const group: SeqGroup = { id: createId('sg'), name: decode(named), participantIds: [] };
      groups.push(group);
      stack.push({ kind: 'box', group });
      continue;
    }
    if (word === 'rect') {
      unsupported.add('a tinted background (rect): what was inside it is kept');
      stack.push({ kind: 'rect' });
      continue;
    }
    // Own keys only: a line that starts `constructor` or `__proto__` is not a fragment.
    if (Object.hasOwn(OPERATORS, word)) {
      const operand: SeqOperand = { id: createId('so'), items: [] };
      const guard = decode(rest);
      if (guard) operand.guard = guard;
      const fragment: SeqFragment = { id: createId('sf'), t: 'fragment', operator: OPERATORS[word]!, operands: [operand] };
      here().push(fragment);
      stack.push({ kind: 'fragment', fragment, operand, waiting: calls.slice(), answered: new Set() });
      continue;
    }
    if (Object.hasOwn(NEXT_BRANCH, word)) {
      const open = [...stack].reverse().find((block) => block.kind === 'fragment');
      if (open?.fragment && open.fragment.operator === NEXT_BRANCH[word]) {
        const operand: SeqOperand = { id: createId('so'), items: [] };
        const guard = decode(rest);
        if (guard) operand.guard = guard;
        open.fragment.operands.push(operand);
        open.operand = operand;
        // Each branch is another way the same moment can go: it starts from what was waiting when
        // the fragment began, so "replies in either branch" is one call answered either way.
        calls = (open.waiting ?? []).slice();
      } else {
        unsupported.add(`"${word}" outside the block it belongs to`);
      }
      continue;
    }
    if (word === 'end') {
      const closed = stack.pop();
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
      const placed = /^(over|left of|right of)\s+(.+?)\s*:\s*(.*)$/i.exec(rest);
      if (placed) {
        const over = placed[2]!.split(',').map((name) => participant(name).id);
        const note: SeqNote = { id: createId('sn'), t: 'note', text: decode(placed[3]!), over: [...new Set(over)] };
        const where = placed[1]!.toLowerCase();
        if (where === 'left of') note.side = 'left';
        if (where === 'right of') note.side = 'right';
        here().push(note);
        continue;
      }
    }

    const said = MESSAGE.exec(line);
    if (said) {
      const from = participant(said[1]!);
      const arrow = said[2]!;
      const mark = said[3]!;
      const to = participant(said[4]!);
      if (arrow.startsWith('<<')) unsupported.add('a message both ways at once: drawn as one call');
      if (arrow.endsWith('x') && !toDestroy.has(to.id) && !toDestroy.has(from.id)) unsupported.add('a lost message (-x): drawn as a call');
      let kind: SeqMessageKind = arrow === '-)' || arrow === '--)' ? 'async' : arrow.startsWith('--') || arrow === '<<-->>' ? 'reply' : 'sync';
      const message: SeqMessage = { id: createId('sm'), t: 'message', from: from.id, to: to.id, kind, label: decode(said[5] ?? '') };
      if (toCreate.delete(to.id)) kind = 'create';
      else if (toDestroy.delete(to.id)) kind = 'destroy';
      else if (toDestroy.delete(from.id)) unsupported.add('a message that destroys its sender: the message is kept');
      message.kind = kind;
      if (kind === 'reply') {
        // The latest call between these two, the other way, that nothing has answered yet.
        const at = calls.findLastIndex((call) => call.from === to.id && call.to === from.id);
        if (at >= 0) {
          const call = calls.splice(at, 1)[0]!;
          message.replyTo = call.id;
          // Mermaid counts work straight down the text and refuses to end the same work in a second
          // branch, so a reply there is written without its `-`. Where an earlier branch already
          // ended this call's work, this one does too.
          if (call.activate && stack.some((block) => block.answered?.has(call))) message.deactivate = true;
          for (const block of stack) block.answered?.add(call);
        }
      } else if (kind === 'sync' && from.id !== to.id) {
        calls.push(message);
      }
      if (mark === '+') message.activate = true;
      if (mark === '-') message.deactivate = true;
      here().push(message);
      last = message;
      continue;
    }

    unsupported.add(`a line it couldn’t read: “${line.length > 40 ? `${line.slice(0, 40)}…` : line}”`);
  }

  const read = normalizeSequence({ participants, groups, items: root });
  if (read.dropped > 0) unsupported.add(`${read.dropped} part${read.dropped === 1 ? '' : 's'} beyond what one sequence holds`);
  if (read.sequence.participants.length === 0) return { ok: false, error: 'There is nobody in that sequence diagram.' };
  const kept = new Set(read.sequence.participants.map((entry) => entry.id));
  const written = new Map([...byName].filter(([, entry]) => kept.has(entry.id)).map(([name, entry]) => [entry.id, name]));
  return { ok: true, title: title?.trim() || UNTITLED_SEQUENCE, sequence: read.sequence, unsupported: [...unsupported], written };
}
