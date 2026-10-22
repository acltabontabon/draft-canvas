import type { ReactElement } from 'react';

/**
 * Each tool's picture: the shape itself in miniature, not a pictogram for it. A Data Store is a small
 * cylinder because that is what lands on the canvas; a Queue is a small tube, a Boundary a dashed
 * frame. There is no icon vocabulary to learn — the toolbar shows the diagram's own shapes.
 *
 * One 20×20 grid, drawn in the current colour, so a glyph takes the button's state (muted, hovered,
 * in hand) like text would.
 */
export function ToolGlyph({ id }: { id: string }) {
  return (
    <svg className="dc-tool-glyph" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      {GLYPHS[id] ?? GLYPHS.service}
    </svg>
  );
}

const GLYPHS: Record<string, ReactElement> = {
  select: <path d="M5.5 3.5 5.5 15.5 8.7 12.6 11 17 12.9 16.1 10.7 11.7 15 11.4Z" />,
  text: (
    <>
      <path d="M4.5 5.5V4h11v1.5" />
      <path d="M10 4v12M7.5 16h5" />
    </>
  ),
  // A note: a sheet with its corner turned.
  note: (
    <>
      <path d="M4 3.5h12v9L12 16.5H4Z" />
      <path d="M12 16.5v-4h4" />
      <path d="M7 7.5h6M7 10.5h3.5" />
    </>
  ),
  code: (
    <>
      <path d="M7 6 3.5 10 7 14M13 6l3.5 4-3.5 4" />
      <path d="M11 4.5 9 15.5" />
    </>
  ),
  // A boundary: a dashed frame with its name on the edge.
  boundary: (
    <>
      <rect x="3" y="4.5" width="14" height="11.5" rx="2" strokeDasharray="2.2 2" />
      <path d="M5.5 4.5h4" strokeWidth="2.6" />
    </>
  ),
  // A service: the canvas's box with its heavier top edge.
  service: (
    <>
      <rect x="3" y="5" width="14" height="10.5" rx="2" />
      <path d="M3.6 5.9h12.8" strokeWidth="2.4" />
      <path d="M6.5 10.5h7" />
    </>
  ),
  database: (
    <>
      <path d="M4.5 5.5c0-2.6 11-2.6 11 0v9c0 2.6-11 2.6-11 0Z" />
      <path d="M4.5 5.5c0 2.6 11 2.6 11 0" />
    </>
  ),
  // A queue: a tube on its side, messages lined up inside, waiting their turn.
  queue: (
    <>
      <path d="M4.5 6.5h11c1 0 1.8 1.6 1.8 3.5s-.8 3.5-1.8 3.5h-11c-1 0-1.8-1.6-1.8-3.5s.8-3.5 1.8-3.5Z" />
      <path d="M15.5 6.5c-1 0-1.8 1.6-1.8 3.5s.8 3.5 1.8 3.5" />
      <path d="M6 8.6v2.8M8.4 8.6v2.8M10.8 8.6v2.8" />
    </>
  ),
  actor: (
    <>
      <circle cx="10" cy="6.5" r="3" />
      <path d="M4 17c0-3.9 2.7-6 6-6s6 2.1 6 6" />
    </>
  ),
  // A junction: the small round point connectors meet at.
  ellipse: (
    <>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M2.5 10h4.3M13.2 10h4.3M10 2.5v4.3" />
    </>
  ),
  // A component: the UML box with its two tabs.
  component: (
    <>
      <rect x="6.5" y="4" width="10.5" height="12" rx="1.5" />
      <rect x="3.5" y="6.5" width="5.5" height="2.6" rx="0.6" />
      <rect x="3.5" y="10.9" width="5.5" height="2.6" rx="0.6" />
    </>
  ),
};
