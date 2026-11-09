import type { ArrangePreset } from '../../store/editorStore';

/**
 * Nodi's skills: what typing `/` in its box offers. Each is something Nodi does itself, at once and at
 * no token cost (a layout, a command), or a question it hands to the person's own agent. Data only:
 * `NodiSkillMenu.tsx` draws them, each with a small picture of what it does, and `Companion.tsx`
 * runs them.
 *
 * The layout skills are the editor's own Arrange with one thing said: which way to read, how much
 * room, or which flow to lay out straight. One undo step each, like Arrange.
 */

/** The small picture beside each skill (`NodiSkillMenu.tsx`), which plays out what it does. */
export type SkillGlyph = 'right' | 'down' | 'flow' | 'room' | 'snug' | 'tidy' | 'explain' | 'risks' | 'present';

export type SkillRun =
  | { kind: 'arrange'; preset: ArrangePreset; done: string }
  | { kind: 'command'; id: string }
  | { kind: 'ask'; prompt: string };

export interface NodiSkill {
  /** Unique, and what is typed after the slash. */
  slash: string;
  title: string;
  hint: string;
  group: 'Arrange' | 'Ask' | 'Show';
  glyph: SkillGlyph;
  run: SkillRun;
}

export interface SkillFacts {
  /** Shapes in the view that a layout would move. */
  shapes: number;
  flows: readonly { id: string; title: string }[];
  /** An agent is there to ask. */
  agent: boolean;
}

/** How many flows get a skill of their own; more are reached by name through ⌘K's arrange. */
const FLOW_SKILLS = 3;

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

/** The skills there are for this view: no layout with nothing to lay out, no question without an agent. */
export function skillsFor(facts: SkillFacts): NodiSkill[] {
  const skills: NodiSkill[] = [];
  if (facts.shapes >= 2) {
    skills.push(
      { slash: 'across', title: 'Left to right', hint: 'Reads across, like a pipeline', group: 'Arrange', glyph: 'right', run: { kind: 'arrange', preset: { direction: 'right' }, done: 'Laid out left to right, boss. Reads like a pipeline now.' } },
      { slash: 'down', title: 'Top down', hint: 'Reads down, callers above what they call', group: 'Arrange', glyph: 'down', run: { kind: 'arrange', preset: { direction: 'down' }, done: 'Stacked top down, boss. Gravity approves.' } },
    );
    const used = new Set(skills.map((s) => s.slash));
    for (const flow of facts.flows.slice(0, FLOW_SKILLS)) {
      let slash = `follow-${slug(flow.title) || 'flow'}`;
      for (let n = 2; used.has(slash); n += 1) slash = `follow-${slug(flow.title) || 'flow'}-${n}`;
      used.add(slash);
      skills.push({
        slash,
        title: `Along “${flow.title}”`,
        hint: 'Its steps in one straight line, the rest around it',
        group: 'Arrange',
        glyph: 'flow',
        run: { kind: 'arrange', preset: { primaryFlow: flow.id }, done: `“${flow.title}” runs in a straight line now, boss. Follow the arrows, not the vibes.` },
      });
    }
    skills.push(
      { slash: 'roomy', title: 'Give it room', hint: 'More space between everything', group: 'Arrange', glyph: 'room', run: { kind: 'arrange', preset: { spacing: 'spacious' }, done: 'Gave everything some room, boss. Social distancing for services.' } },
      { slash: 'snug', title: 'Snug', hint: 'Closer together, for a smaller screen', group: 'Arrange', glyph: 'snug', run: { kind: 'arrange', preset: { spacing: 'compact' }, done: 'Packed it snug, boss. Cosy. Slightly claustrophobic.' } },
    );
  }
  if (facts.shapes >= 2) skills.push({ slash: 'tidy', title: 'Tidy connectors', hint: 'Straighter lines, nothing moved', group: 'Arrange', glyph: 'tidy', run: { kind: 'command', id: 'tidy-connections' } });
  if (facts.agent && facts.shapes > 0) {
    skills.push(
      { slash: 'explain', title: 'Walk me through it', hint: 'Your agent explains the diagram', group: 'Ask', glyph: 'explain', run: { kind: 'ask', prompt: 'Explain this diagram' } },
      { slash: 'risks', title: 'What breaks first?', hint: 'Your agent looks for the weak spots', group: 'Ask', glyph: 'risks', run: { kind: 'ask', prompt: 'What are the risks here?' } },
    );
  }
  if (facts.flows[0]) skills.push({ slash: 'present', title: `Present “${facts.flows[0].title}”`, hint: 'Play the flow step by step', group: 'Show', glyph: 'present', run: { kind: 'command', id: `present-flow:${facts.flows[0].id}` } });
  return skills;
}

/** What is typed after the slash, while the draft is a skill being chosen; null otherwise. */
export function skillQuery(draft: string): string | null {
  const match = /^\/(\S*)$/.exec(draft.trimStart());
  return match ? match[1]!.toLowerCase() : null;
}

/** The skills `query` picks: those whose slash starts with it first, then any whose words do. */
export function matchSkills(skills: readonly NodiSkill[], query: string): NodiSkill[] {
  if (!query) return [...skills];
  const starts = skills.filter((s) => s.slash.startsWith(query));
  const words = skills.filter((s) => !starts.includes(s) && `${s.slash} ${s.title} ${s.hint}`.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.startsWith(query)));
  return [...starts, ...words];
}
