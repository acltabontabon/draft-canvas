import { memo } from 'react';

/**
 * A small, deliberate icon set. Every glyph is a stroked 24-unit path so the
 * toolbar reads as one family rather than a grab-bag of pictograms.
 */
const PATHS = {
  back: 'M15 19l-7-7 7-7',
  forward: 'M9 5l7 7-7 7',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-4',
  redo: 'M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h4',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  present: 'M4 5h16v10H4z M9 20l3-5 3 5',
  export: 'M12 4v11 M8 11l4 4 4-4 M4 19h16',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  copy: 'M9 9h10v11H9z M5 15V4h10',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  keyboard: 'M3 7h18v10H3z M7 11h.01 M11 11h.01 M15 11h.01 M8 14h8',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M12 2v2 M12 20v2 M4 12H2 M22 12h-2 M5 5l1.5 1.5 M17.5 17.5L19 19 M19 5l-1.5 1.5 M6.5 17.5L5 19',
  moon: 'M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10z',
  lock: 'M6 11h12v9H6z M9 11V8a3 3 0 0 1 6 0v3',
  play: 'M7 4l12 8-12 8z',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  upload: 'M12 20V9 M8 13l4-4 4 4 M4 5h16',
  grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  sequence: 'M5 6h14 M5 12h14 M5 18h14',
  align: 'M4 4v16 M9 8h11 M9 16h7',
  more: 'M6 12h.01 M12 12h.01 M18 12h.01',
  check: 'M5 13l4 4L19 7',
  pencil: 'M4 20h4L20 8l-4-4L4 16z',
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
    >
      <path d={PATHS[name]} />
    </svg>
  );
});
