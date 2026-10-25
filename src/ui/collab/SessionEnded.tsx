import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { EndReason } from '../../collab/protocol';
import { useCollabStore } from '../../store/collabStore';
import { Button } from '../common/Button';
import { trapTab } from '../common/focusTrap';
import { END_MESSAGES, endHeadline, initialsOf, mayKeepCopy } from './collabCopy';

interface SessionEndedProps {
  /**
   * Opened from the desktop's local network link, a plain-http address: a copy kept in this browser
   * there could be read by whatever answers at that address next, so the way out is an export.
   */
  exportOnly: boolean;
  onKeep: () => void;
  onHome: () => void;
}

/** Which line in the picture gives: the owner's, this person's own, or the owner's fading out. */
type Break = 'owner' | 'self' | 'fray';

const BREAKS: Partial<Record<EndReason, Break>> = { removed: 'self', timeout: 'fray' };

const SAID_IN_HEADLINE: ReadonlySet<EndReason> = new Set(['ended', 'owner-left', 'document-changed', 'removed', 'timeout']);

/** The rest: why, where it says more than the headline, then what is true of the copy left here. */
function endBody(reason: EndReason, owner: string | null, exportOnly: boolean): string {
  if (!mayKeepCopy(reason)) return `The canvas was ${owner?.trim() ? `${owner.trim()}’s` : 'the owner’s'}, and it goes with the session: nothing of it stays on this device.`;
  const kept = 'What’s on screen was a live copy, and it isn’t saved anywhere on this device.';
  const ways = exportOnly ? 'Export a copy to keep it, or let it go.' : 'Keep a copy to carry on with it, or let it go.';
  return `${SAID_IN_HEADLINE.has(reason) ? kept : `${END_MESSAGES[reason]} ${kept}`} ${ways}`;
}

// One coordinate space for the drawing and the seats laid over it, as in `SessionScene`.
const W = 480;
const H = 168;
const OWNER = { x: 66, y: 84 };
const SELF = { x: 414, y: 84 };
const SHEET = { left: 150, right: 330, top: 18, bottom: 150 };
const at = (point: { x: number; y: number }): CSSProperties => ({ left: `${(point.x / W) * 100}%`, top: `${(point.y / H) * 100}%` });

/**
 * The card a collaborator's canvas closes behind when the session ends on them: the session's own
 * picture (`SessionScene`), one last time — the line to the canvas snips, the owner's seat empties,
 * their pointer wanders off the sheet, and the sheet is postmarked. Everything under it is inert:
 * the copy on screen is nobody's file now, so the only ways on are keeping a copy or going home —
 * and, for someone the owner removed, only going home, with the canvas behind faded out entirely.
 */
export function SessionEnded({ exportOnly, onKeep, onHome }: SessionEndedProps) {
  const { reason, owner, selfName, selfColor } = useCollabStore(
    useShallow((state) => ({ reason: state.endReason ?? 'ended', owner: state.endedOwner, selfName: state.selfName, selfColor: state.selfColor })),
  );
  const titleId = useId();
  const bodyId = useId();
  // Referenced through `url(#…)`, where React's own id punctuation doesn't parse.
  const worn = `dc-worn-${useId().replace(/[^\w-]/g, '')}`;
  const card = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const keepable = mayKeepCopy(reason);
  const cut: Break = BREAKS[reason] ?? 'owner';
  // When it ended, as a postmark says it; fixed at the moment the card first drew.
  const [stamp] = useState(() => new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));

  useEffect(() => {
    first.current?.focus({ preventScroll: true });
  }, []);

  // The card is the only thing that takes keys: Tab stays on it, and nothing else on the page hears
  // a key while it is up (`aria-modal` already holds back the editor's own shortcuts).
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Export a copy opens its own dialog over this one, and Tab there is that dialog's.
      const target = event.target instanceof Element ? event.target : null;
      if (!card.current || (target?.closest('[aria-modal="true"]') && !card.current.contains(target))) return;
      trapTab(event, card.current);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div className="dc-session-end" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} data-cut={cut} data-keepable={keepable ? undefined : 'false'}>
      <div ref={card} className="dc-session-end-card">
        <div className="dc-session-end-art" aria-hidden="true">
          <svg viewBox={`0 0 ${W} ${H}`}>
            <defs>
              {/* A rubber stamp never inks evenly: speckle its alpha with a little noise. */}
              <filter id={worn} x="-10%" y="-10%" width="120%" height="120%">
                <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="7" result="noise" />
                <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.4 2.35" result="wear" />
                <feComposite in="SourceGraphic" in2="wear" operator="in" />
              </filter>
            </defs>
            <g transform={`rotate(-1.6 ${(SHEET.left + SHEET.right) / 2} ${(SHEET.top + SHEET.bottom) / 2})`}>
              <rect className="dc-scene-under" x={SHEET.left + 5} y={SHEET.top + 6} width={SHEET.right - SHEET.left} height={SHEET.bottom - SHEET.top} rx="9" />
              <rect className="dc-scene-sheet" x={SHEET.left} y={SHEET.top} width={SHEET.right - SHEET.left} height={SHEET.bottom - SHEET.top} rx="9" />
              {/* The canvas everyone was drawing on, left as it was. */}
              <g className="dc-session-end-diagram">
                <path d="M222 50 H258 M196 62 V100 M284 62 V94 M222 112 H262" />
                <rect x="170" y="38" width="52" height="24" rx="5" />
                <rect x="258" y="38" width="52" height="24" rx="5" />
                <rect x="170" y="100" width="52" height="24" rx="5" />
                <path d="M262 100 C262 92 306 92 306 100 V122 C306 130 262 130 262 122 Z M262 100 C262 108 306 108 306 100" />
                <path className="dc-session-end-label" d="M182 50 H206 M270 50 H292 M182 112 H200" />
              </g>
              {/* Each person's pointer, where it was: the owner's leaves; this person's stays put. */}
              <g className="dc-session-end-pointer" data-who="owner" data-peer-color={(owner?.color ?? 0) % 8}>
                <path transform="translate(240 72)" d="M0 0 L0 13 L3.6 9.8 L6.2 15.2 L8.5 14.2 L5.9 9 L10.6 8.7 Z" />
              </g>
              <g className="dc-session-end-pointer" data-who="self" data-peer-color={selfColor % 8}>
                <path transform="translate(226 128)" d="M0 0 L0 13 L3.6 9.8 L6.2 15.2 L8.5 14.2 L5.9 9 L10.6 8.7 Z" />
              </g>
              {/* The postmark: when it ended, pressed onto the sheet. */}
              <g className="dc-session-end-stamp" transform="translate(240 84) rotate(-9)">
                <g className="dc-session-end-stamp-ink" filter={`url(#${worn})`}>
                  <rect x="-74" y="-23" width="148" height="46" rx="7" />
                  <rect className="dc-session-end-stamp-inner" x="-69" y="-18" width="138" height="36" rx="4" />
                  <text className="dc-session-end-stamp-word" x="0" y="-1" textAnchor="middle">
                    SESSION ENDED
                  </text>
                  <text className="dc-session-end-stamp-time" x="0" y="11" textAnchor="middle">
                    {stamp}
                  </text>
                </g>
              </g>
            </g>
            {/* The owner's line, in two halves that part where it snips. */}
            <g className="dc-session-end-tie" data-who="owner" data-peer-color={(owner?.color ?? 0) % 8}>
              <path className="dc-session-end-half" data-half="near" d={`M${OWNER.x + 20} ${OWNER.y} C${OWNER.x + 32} ${OWNER.y} ${OWNER.x + 38} ${OWNER.y + 1} ${OWNER.x + 44} ${OWNER.y + 1.5}`} />
              <path className="dc-session-end-half" data-half="far" d={`M${OWNER.x + 50} ${OWNER.y + 2} C${OWNER.x + 62} ${OWNER.y + 3} ${SHEET.left - 22} ${OWNER.y + 4} ${SHEET.left - 4} ${OWNER.y + 4}`} />
              <Snip x={OWNER.x + 47} y={OWNER.y + 1.8} />
            </g>
            <g className="dc-session-end-tie" data-who="self" data-peer-color={selfColor % 8}>
              <path className="dc-session-end-half" data-half="far" d={`M${SHEET.right + 4} ${SELF.y - 3} C${SHEET.right + 22} ${SELF.y - 3} ${SELF.x - 62} ${SELF.y - 1} ${SELF.x - 50} ${SELF.y - 0.5}`} />
              <path className="dc-session-end-half" data-half="near" d={`M${SELF.x - 44} ${SELF.y} C${SELF.x - 38} ${SELF.y} ${SELF.x - 30} ${SELF.y} ${SELF.x - 20} ${SELF.y}`} />
              <Snip x={SELF.x - 47} y={SELF.y - 0.2} />
            </g>
          </svg>
          <span className="dc-scene-seat dc-session-end-seat" data-who="owner" data-peer-color={(owner?.color ?? 0) % 8} style={at(OWNER)}>
            <span className="dc-session-end-chair" />
            <span className="dc-scene-face">{owner?.name.trim() ? initialsOf(owner.name) : ''}</span>
            <span className="dc-scene-name">{owner?.name.trim() || 'Owner'}</span>
          </span>
          <span className="dc-scene-seat dc-session-end-seat" data-who="self" data-peer-color={selfColor % 8} style={at(SELF)}>
            <span className="dc-scene-face">{selfName.trim() ? initialsOf(selfName) : ''}</span>
            <span className="dc-scene-name">You</span>
          </span>
        </div>
        <h2 id={titleId} className="dc-session-end-title">
          {endHeadline(reason, owner?.name ?? null)}
        </h2>
        <p id={bodyId} className="dc-session-end-body">
          {endBody(reason, owner?.name ?? null, exportOnly)}
        </p>
        <div className="dc-session-end-actions">
          {keepable && (
            <Button ref={first} variant="solid" icon={exportOnly ? 'export' : 'copy'} onClick={onKeep}>
              {exportOnly ? 'Export a copy' : 'Keep a copy'}
            </Button>
          )}
          <Button ref={keepable ? undefined : first} variant={keepable ? 'quiet' : 'solid'} onClick={onHome}>
            Back to home
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Where a line gives: a small burst of strokes, there and gone. */
function Snip({ x, y }: { x: number; y: number }) {
  return (
    <g className="dc-session-end-snip" transform={`translate(${x} ${y})`}>
      <path d="M0 -5 V-9 M3.6 -3.6 L6.4 -6.4 M5 0 H9 M3.6 3.6 L6.4 6.4 M0 5 V9 M-3.6 3.6 L-6.4 6.4 M-5 0 H-9 M-3.6 -3.6 L-6.4 -6.4" />
    </g>
  );
}
