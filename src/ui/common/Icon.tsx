import { memo } from 'react';

/**
 * A small, deliberate icon set. Every glyph is a stroked 24-unit path so the
 * toolbar reads as one family rather than a grab-bag of pictograms.
 */
const PATHS = {
  back: 'M15 19l-7-7 7-7',
  forward: 'M9 5l7 7-7 7',
  up: 'M5 15l7-7 7 7',
  down: 'M19 9l-7 7-7-7',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-4',
  redo: 'M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h4',
  present: 'M4 5h16v10H4z M9 20l3-5 3 5',
  export: 'M12 4v11 M8 11l4 4 4-4 M4 19h16',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  copy: 'M9 9h10v11H9z M5 15V4h10',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  keyboard: 'M3 7h18v10H3z M7 11h.01 M11 11h.01 M15 11h.01 M8 14h8',
  lock: 'M6 11h12v9H6z M9 11V8a3 3 0 0 1 6 0v3',
  play: 'M7 4l12 8-12 8z',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  upload: 'M12 20V9 M8 13l4-4 4 4 M4 5h16',
  alignLeft: 'M4 6h16 M4 12h10 M4 18h13',
  alignCenter: 'M4 6h16 M7 12h10 M5.5 18h13',
  alignRight: 'M4 6h16 M10 12h10 M7 18h13',
  more: 'M6 12h.01 M12 12h.01 M18 12h.01',
  check: 'M5 13l4 4L19 7',
  pencil: 'M4 20h4L20 8l-4-4L4 16z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v6 M12 7.5h.01',
  github:
    'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  linkedin: 'M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z M2 9h4v12H2z M4 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  globe:
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 6l-10 7L2 6',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.4 M12 16.8h.01',
  folder: 'M3 6h6l2 2h10v11H3z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35',
  image: 'M4 4h16v16H4z M8 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M4 16l5-5 4 4 3-3 4 4',
  code: 'M9 6l-6 6 6 6 M15 6l6 6-6 6',
  // Chevron-into-a-bar, the universal "skip to the previous/next thing". Deliberately *not* the
  // plain `back`/`forward` chevrons the presentation's step controls use: in Presentation Mode the
  // two pairs sit on the same bar, and the bar is what tells a presenter mid-sentence whether they
  // are about to move one step or leave this flow for another one.
  flowPrevious: 'M16 5l-7 7 7 7 M6 5v14',
  flowNext: 'M8 5l7 7-7 7 M18 5v14',
  // A stepped route with an arrowhead — the same orthogonal elbow the canvas draws connectors
  // with, so the glyph is the product's own vocabulary rather than a generic "path" pictogram.
  flow: 'M4 7h4a3 3 0 0 1 3 3v4a3 3 0 0 0 3 3h4 M15 14l3 3-3 3',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export const Icon = memo(function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      // Lets a caller tune one glyph optically without a wrapper class — see the toolbar's
      // utility sizing, where `search` and `more` need a nudge the others don't.
      data-icon={name}
    >
      <path d={PATHS[name]} />
    </svg>
  );
});
