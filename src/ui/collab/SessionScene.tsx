import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../common/Icon';
import { initialsOf } from './collabCopy';

/**
 * How someone sits at the table:
 * - `live`: in the session;
 * - `reconnecting`: dropped, coming back;
 * - `arriving`: about to ask (their name still being typed);
 * - `knocking`: asking to join;
 * - `joining`: let in, connecting.
 */
export type SeatState = 'live' | 'reconnecting' | 'arriving' | 'knocking' | 'joining';

export interface ScenePerson {
  key: string;
  name: string;
  /** Index into the peer palette; ignored while knocking, when nobody has a colour yet. */
  color: number;
  state: SeatState;
  you?: boolean;
}

interface SessionSceneProps {
  /** The person whose canvas it is, on the left; a blank name while a joiner doesn't know it yet. */
  owner: { name: string; color: number; you?: boolean };
  /** Everyone else, in order; three seats on the right, the last one saying how many more. */
  people: ScenePerson[];
  /**
   * What stays private and who sees what, for whoever wants to know: kept behind a lock sealed onto
   * the canvas, and opened by clicking it, rather than said on every screen.
   */
  privacy?: ReactNode;
}

// One coordinate space for the drawing and the seats laid over it (as percentages of it).
const W = 480;
const H = 150;
const OWNER = { x: 74, y: 75 };
const SEATS = [
  { x: 404, y: 30 },
  { x: 432, y: 75 },
  { x: 404, y: 120 },
];
/** Where the sheet's right and left edges are met by the lines from each seat. */
const SHEET = { left: 150, right: 330, top: 18, bottom: 132 };
/** Shapes on the sheet, for selection outlines: [x, y, w, h]. */
const SHAPES: ReadonlyArray<readonly [number, number, number, number]> = [
  [170, 34, 52, 24],
  [258, 34, 52, 24],
  [170, 94, 52, 24],
  [262, 88, 44, 34],
];
/** The seal on the sheet's top-right corner. */
const SEAL = { x: 322, y: 22 };
/** Where each person's pointer wanders, near a shape it isn't outlining. */
const POINTERS = [
  { x: 234, y: 66 },
  { x: 312, y: 70 },
  { x: 208, y: 82 },
  { x: 246, y: 116 },
];

const at = (point: { x: number; y: number }): CSSProperties => ({ left: `${(point.x / W) * 100}%`, top: `${(point.y / H) * 100}%` });

/**
 * The session as a picture: the canvas in the middle, its owner on one side, everyone else around it,
 * each pointing at something in their own colour — how a live session feels, drawn the way Draft
 * Canvas draws. It follows what is real (who is here, who is knocking) and draws itself in once.
 * Decorative: the dialog says all of it in words.
 */
export function SessionScene({ owner, people, privacy }: SessionSceneProps) {
  const shown = people.slice(0, SEATS.length);
  const more = people.length - shown.length;
  // The last seat says "+N" rather than dropping people silently.
  if (more > 0) shown[shown.length - 1] = { key: 'more', name: `+${more + 1}`, color: 7, state: 'live' };
  const pointing = [
    { key: 'owner', color: owner.color },
    ...shown.filter((person) => person.state === 'live' && person.key !== 'more').map((person) => ({ key: person.key, color: person.color })),
  ];
  return (
    <div className="dc-scene">
      <div className="dc-scene-layer" aria-hidden="true">
        <svg className="dc-scene-art" viewBox={`0 0 ${W} ${H}`}>
          {/* A paper stack: the canvas everyone shares. */}
          <g transform={`rotate(-1.6 ${(SHEET.left + SHEET.right) / 2} ${(SHEET.top + SHEET.bottom) / 2})`}>
            <rect className="dc-scene-under" x={SHEET.left + 5} y={SHEET.top + 6} width={SHEET.right - SHEET.left} height={SHEET.bottom - SHEET.top} rx="9" />
            <rect className="dc-scene-sheet" x={SHEET.left} y={SHEET.top} width={SHEET.right - SHEET.left} height={SHEET.bottom - SHEET.top} rx="9" />
            <g className="dc-scene-diagram">
              <path className="dc-scene-ink" pathLength={1} d="M222 46 H258" />
              <path className="dc-scene-ink" pathLength={1} d="M196 58 V94" />
              <path className="dc-scene-ink" pathLength={1} d="M284 58 V88" />
              <path className="dc-scene-ink" pathLength={1} d="M222 106 H262" />
              {SHAPES.slice(0, 3).map(([x, y, w, h], index) => (
                <g key={index}>
                  <path className="dc-scene-ink dc-scene-shape" pathLength={1} d={`M${x + 5} ${y} H${x + w - 5} Q${x + w} ${y} ${x + w} ${y + 5} V${y + h - 5} Q${x + w} ${y + h} ${x + w - 5} ${y + h} H${x + 5} Q${x} ${y + h} ${x} ${y + h - 5} V${y + 5} Q${x} ${y} ${x + 5} ${y} Z`} />
                  <path className="dc-scene-label" d={`M${x + 12} ${y + h / 2} H${x + w - 12 - index * 6}`} />
                </g>
              ))}
              {/* A data store, because every architecture has one. */}
              <path
                className="dc-scene-ink dc-scene-shape"
                pathLength={1}
                d="M262 94 C262 86 306 86 306 94 V116 C306 124 262 124 262 116 Z M262 94 C262 102 306 102 306 94"
              />
            </g>
            {shown.map((person, index) =>
              person.state === 'live' && person.key !== 'more' ? (
                <rect
                  key={person.key}
                  className="dc-scene-held"
                  data-peer-color={person.color % 8}
                  x={SHAPES[(index + 1) % SHAPES.length]![0] - 3.5}
                  y={SHAPES[(index + 1) % SHAPES.length]![1] - 3.5}
                  width={SHAPES[(index + 1) % SHAPES.length]![2] + 7}
                  height={SHAPES[(index + 1) % SHAPES.length]![3] + 7}
                  rx="8"
                />
              ) : null,
            )}
          </g>
          {/* Each person's line to the canvas: solid while they're in, travelling while they come in. */}
          <path className="dc-scene-tie" data-peer-color={owner.color % 8} d={`M${OWNER.x + 20} ${OWNER.y} C${OWNER.x + 44} ${OWNER.y} ${SHEET.left - 24} ${OWNER.y + 4} ${SHEET.left - 4} ${OWNER.y + 4}`} />
          {SEATS.map((seat, index) => {
            const person = shown[index];
            const y = SHEET.top + 24 + index * 36;
            return (
              <path
                key={index}
                className="dc-scene-tie"
                data-state={person?.state ?? 'empty'}
                data-peer-color={person && person.state !== 'knocking' && person.state !== 'arriving' ? person.color % 8 : undefined}
                d={`M${seat.x - 18} ${seat.y} C${seat.x - 46} ${seat.y} ${SHEET.right + 26} ${y} ${SHEET.right + 4} ${y}`}
              />
            );
          })}
          {pointing.slice(0, POINTERS.length).map((pointer, index) => (
            <g
              key={pointer.key}
              className="dc-scene-pointer"
              data-peer-color={pointer.color % 8}
              style={{ '--dc-scene-x': `${POINTERS[index]!.x}px`, '--dc-scene-y': `${POINTERS[index]!.y}px`, animationDelay: `${-index * 1.7}s`, animationDuration: `${7 + index * 1.3}s` } as CSSProperties}
            >
              <path d="M0 0 L0 13 L3.6 9.8 L6.2 15.2 L8.5 14.2 L5.9 9 L10.6 8.7 Z" />
            </g>
          ))}
        </svg>
        <span className="dc-scene-seat" data-state="live" data-peer-color={owner.color % 8} style={at(OWNER)}>
          <span className="dc-scene-face">{owner.name.trim() ? initialsOf(owner.name) : <Icon name="pencil" />}</span>
          <span className="dc-scene-name">{owner.you ? 'You' : owner.name.trim() || 'Owner'}</span>
        </span>
        {SEATS.map((seat, index) => {
          const person = shown[index];
          if (!person) {
            return (
              <span key={`empty-${index}`} className="dc-scene-seat" data-state="empty" style={at(seat)}>
                <span className="dc-scene-face" />
              </span>
            );
          }
          const colored = person.state !== 'knocking' && person.state !== 'arriving';
          return (
            <span key={person.key} className="dc-scene-seat" data-state={person.state} data-peer-color={colored ? person.color % 8 : undefined} style={at(seat)}>
              <span className="dc-scene-face">{person.key === 'more' ? person.name : person.name.trim() ? initialsOf(person.name) : ''}</span>
              {person.state === 'knocking' && <span className="dc-scene-knock">?</span>}
              {person.key !== 'more' && person.name.trim() && <span className="dc-scene-name">{person.you ? 'You' : person.name}</span>}
            </span>
          );
        })}
      </div>
      {privacy && <Seal>{privacy}</Seal>}
    </div>
  );
}

/**
 * A lock sealed onto the corner of the canvas: the one place the privacy story lives. Clicking it
 * unfolds a note beneath; clicking elsewhere, pressing Escape or clicking it again folds it away.
 */
function Seal({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  return (
    <span
      ref={root}
      className="dc-scene-seal-anchor"
      style={at(SEAL)}
      onKeyDown={(event) => {
        // Escape folds the note, not the whole dialog.
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="dc-scene-seal"
        aria-expanded={open}
        aria-controls={id}
        aria-label="How your diagram stays private"
        title="How your diagram stays private"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="lock" />
      </button>
      {open && (
        <span id={id} className="dc-scene-note" role="note">
          <span className="dc-scene-note-title">Private by design</span>
          {children}
        </span>
      )}
    </span>
  );
}
