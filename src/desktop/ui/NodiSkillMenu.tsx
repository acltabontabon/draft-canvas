import { memo, type CSSProperties } from 'react';
import type { NodiSkill, SkillGlyph } from './nodiSkills';

/**
 * What `/` in Nodi's box offers (`nodiSkills.ts`): a list over the composer, each skill with a small
 * picture of what it does. Highlighted, the picture plays it out in miniature — scattered boxes
 * settle into the layout, then their connectors draw in, the same choreography the canvas plays when
 * the skill runs (`canvas/arrangeMotion.ts`) — so what a skill will do is seen before it is done.
 *
 * The composer keeps the focus and the keys (↑ ↓ to choose, Enter to run, Tab to complete, Escape to
 * put the slash away); this list only shows and takes the pointer.
 */

export const SKILL_LIST_ID = 'dc-nodi-skills';
export const skillOptionId = (slash: string) => `dc-nodi-skill-${slash}`;

type Part = { x: number; y: number; w?: number; h?: number; sx: number; sy: number; lit?: boolean };
type Line = { d: string; lit?: boolean };

/** Where each part rests (the result), and how far off it starts when the picture plays. */
const PICTURES: Record<SkillGlyph, { boxes: Part[]; lines: Line[]; messy?: string }> = {
  right: {
    boxes: [
      { x: 1, y: 8, sx: 3, sy: -6 },
      { x: 12.5, y: 8, sx: -2, sy: 7 },
      { x: 24, y: 8, sx: -7, sy: -4 },
    ],
    lines: [{ d: 'M8 10.5H12.5' }, { d: 'M19.5 10.5H24' }],
  },
  down: {
    boxes: [
      { x: 12.5, y: 1, sx: -8, sy: 3 },
      { x: 12.5, y: 8.5, sx: 8, sy: -1 },
      { x: 12.5, y: 16, sx: -5, sy: -5 },
    ],
    lines: [{ d: 'M16 6V8.5' }, { d: 'M16 13.5V16' }],
  },
  flow: {
    boxes: [
      { x: 1, y: 8.5, sx: 0, sy: -6, lit: true },
      { x: 12.5, y: 8.5, sx: 0, sy: 6, lit: true },
      { x: 24, y: 8.5, sx: 0, sy: -5, lit: true },
      { x: 12.5, y: 1, w: 7, h: 4, sx: 5, sy: 2 },
      { x: 12.5, y: 17, w: 7, h: 4, sx: -5, sy: -2 },
    ],
    lines: [{ d: 'M8 11H12.5', lit: true }, { d: 'M19.5 11H24', lit: true }],
  },
  room: {
    boxes: [
      { x: 1, y: 1.5, sx: 8, sy: 4 },
      { x: 24, y: 1.5, sx: -8, sy: 4 },
      { x: 1, y: 15.5, sx: 8, sy: -4 },
      { x: 24, y: 15.5, sx: -8, sy: -4 },
    ],
    lines: [{ d: 'M8 4H24' }, { d: 'M4.5 6.5V15.5' }],
  },
  snug: {
    boxes: [
      { x: 8, y: 4, sx: -7, sy: -3 },
      { x: 17, y: 4, sx: 7, sy: -3 },
      { x: 8, y: 12, sx: -7, sy: 4 },
      { x: 17, y: 12, sx: 7, sy: 4 },
    ],
    lines: [{ d: 'M15 6.5H17' }, { d: 'M11.5 9V12' }],
  },
  tidy: {
    boxes: [
      { x: 1, y: 2, sx: 0, sy: 0 },
      { x: 24, y: 15, sx: 0, sy: 0 },
    ],
    lines: [{ d: 'M8 4.5H15.5V17.5H24' }],
    messy: 'M8 4.5C20 1 4 12 14 11S10 20 24 17.5',
  },
  explain: {
    boxes: [{ x: 3, y: 2, w: 26, h: 14, sx: 0, sy: 4 }],
    lines: [{ d: 'M7 6.5H25' }, { d: 'M7 9.5H21' }, { d: 'M7 12.5H17' }, { d: 'M9 16L7 20.5L13 16' }],
  },
  risks: {
    boxes: [
      { x: 1, y: 8, sx: -3, sy: 0 },
      { x: 24, y: 8, sx: 3, sy: 0 },
    ],
    lines: [{ d: 'M8 10.5H12' }, { d: 'M20 10.5H24' }, { d: 'M17 4L13.5 11H18L14.5 18', lit: true }],
  },
  present: {
    boxes: [],
    lines: [{ d: 'M11 4L23 11L11 18Z', lit: true }, { d: 'M3 21H29' }],
  },
};

const BOX = { w: 7, h: 5 };

/** The picture: at rest, what the skill leaves behind; highlighted, getting there. */
const Glyph = memo(function Glyph({ glyph }: { glyph: SkillGlyph }) {
  const picture = PICTURES[glyph];
  return (
    <svg className="dc-skill-glyph" viewBox="0 0 32 22" width="40" height="28" aria-hidden="true" data-glyph={glyph}>
      {picture.messy && <path className="dc-skill-messy" d={picture.messy} pathLength={1} />}
      {picture.lines.map((line, i) => (
        <path
          key={`l${i}`}
          className="dc-skill-line"
          data-lit={line.lit ? 'true' : undefined}
          d={line.d}
          pathLength={1}
          style={{ '--d': `${picture.boxes.length * 45 + 200 + i * 70}ms` } as CSSProperties}
        />
      ))}
      {picture.boxes.map((box, i) => (
        <rect
          key={`b${i}`}
          className="dc-skill-box"
          data-lit={box.lit ? 'true' : undefined}
          x={box.x}
          y={box.y}
          width={box.w ?? BOX.w}
          height={box.h ?? BOX.h}
          rx={1}
          style={{ '--sx': `${box.sx}px`, '--sy': `${box.sy}px`, '--d': `${i * 45}ms` } as CSSProperties}
        />
      ))}
    </svg>
  );
});

export const NodiSkillMenu = memo(function NodiSkillMenu({
  skills,
  active,
  query,
  onActive,
  onPick,
}: {
  skills: readonly NodiSkill[];
  active: number;
  query: string;
  onActive: (index: number) => void;
  onPick: (skill: NodiSkill) => void;
}) {
  return (
    <div className="dc-skill-menu">
      <p className="dc-skill-menu-head" aria-hidden="true">
        <span className="dc-skill-menu-title">Skills</span>
        <span className="dc-skill-menu-keys">↑↓ choose · ↵ run · esc close</span>
      </p>
      {skills.length === 0 ? (
        <p className="dc-skill-empty" role="status">
          No skill called /{query}, boss. Enter asks it as a question.
        </p>
      ) : (
        <ul className="dc-skill-list" id={SKILL_LIST_ID} role="listbox" aria-label="Nodi’s skills">
          {skills.map((skill, i) => (
            <li
              key={skill.slash}
              id={skillOptionId(skill.slash)}
              role="option"
              aria-selected={i === active}
              className="dc-skill"
              data-active={i === active ? 'true' : undefined}
              data-group-start={i === 0 || skills[i - 1]!.group !== skill.group ? skill.group : undefined}
              style={{ '--i': i } as CSSProperties}
              // The composer keeps the focus: a click here must not take it.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => i !== active && onActive(i)}
              onClick={() => onPick(skill)}
            >
              <Glyph glyph={skill.glyph} />
              <span className="dc-skill-text">
                <span className="dc-skill-title">
                  {skill.title}
                  <span className="dc-skill-slash">/{skill.slash}</span>
                </span>
                <span className="dc-skill-hint">{skill.hint}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
