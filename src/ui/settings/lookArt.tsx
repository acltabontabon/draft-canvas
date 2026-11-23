import type { ReactNode } from 'react';

/**
 * What each choice in Appearance looks like, drawn small: the pictures `LookTiles` shows. Kept
 * apart from the component so the page's hot reload has one thing per file.
 */

/** A tile's drawing: 56 by 30, in the tile's own text colour. */
function Art({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 56 30" width="56" height="30" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const BOX = 'M8 6H48V24H8Z';
const BOX_DRAFT = 'M8.4 6.5C20 5.6 36 6.6 47.8 5.8C48.5 12 47.6 18 48.3 24.2C36 24.9 20 23.6 8 24.4C7.4 18 8.6 12 8.4 6.5Z';
const BOX_SKETCH = 'M7.6 7.2C19 5 37 7.4 48.6 5.2C49.4 11 47 19 48.8 24.8C37 26 19 22.8 7.2 24.8C6.2 19 9.2 12 7.6 7.2Z';

export const HAND_ART = {
  clean: (
    <Art>
      <path d={BOX} strokeWidth="1.6" />
    </Art>
  ),
  draft: (
    <Art>
      <path d={BOX_DRAFT} strokeWidth="1.6" />
    </Art>
  ),
  sketch: (
    <Art>
      <path d={BOX_SKETCH} strokeWidth="1.5" />
      <path d="M8.6 5.6C20 7 36 5 47.6 6.8C47 12 49 18 47.6 23.8C36 22.6 20 25.4 8.6 23.6C9.4 18 7 12 8.6 5.6Z" strokeWidth="1" opacity="0.5" />
    </Art>
  ),
};

const WAVE = (amp: number) => `M6 15C12 ${15 - amp} 16 ${15 - amp} 22 15S32 ${15 + amp} 38 15S46 ${15 - amp} 50 15`;
export const STEADY_ART = {
  calm: (
    <Art>
      <path d={WAVE(1.2)} strokeWidth="1.8" />
    </Art>
  ),
  even: (
    <Art>
      <path d={WAVE(3.2)} strokeWidth="1.8" />
    </Art>
  ),
  lively: (
    <Art>
      <path d={WAVE(6.5)} strokeWidth="1.8" />
    </Art>
  ),
};

export const WEIGHT_ART = {
  fine: (
    <Art>
      <path d="M8 15H48" strokeWidth="1" />
    </Art>
  ),
  regular: (
    <Art>
      <path d="M8 15H48" strokeWidth="2.2" />
    </Art>
  ),
  bold: (
    <Art>
      <path d="M8 15H48" strokeWidth="4.2" />
    </Art>
  ),
};

const corner = (r: number) => `M12 26V${6 + r}Q12 6 ${12 + r} 6H46`;
export const CORNER_ART = {
  sharp: (
    <Art>
      <path d={corner(1)} strokeWidth="2" />
    </Art>
  ),
  soft: (
    <Art>
      <path d={corner(6)} strokeWidth="2" />
    </Art>
  ),
  round: (
    <Art>
      <path d={corner(14)} strokeWidth="2" />
    </Art>
  ),
};

const lifted = (blur: number, dy: number, opacity: number) => (
  <Art>
    {opacity > 0 && <rect x="14" y={6 + dy} width="28" height="16" rx="4" fill="currentColor" stroke="none" opacity={opacity} style={{ filter: `blur(${blur}px)` }} />}
    <rect x="14" y="6" width="28" height="16" rx="4" fill="var(--dc-surface-raised)" strokeWidth="1.6" />
  </Art>
);
export const SHADOW_ART = {
  off: lifted(0, 0, 0),
  soft: lifted(1.5, 2, 0.28),
  deep: lifted(3, 6, 0.6),
};

export const HEAD_ART = {
  nib: (
    <Art>
      <path d="M8 15H40" strokeWidth="1.8" />
      <path d="M48 15L37 9.5Q40 15 37 20.5Z" fill="currentColor" strokeWidth="1" />
    </Art>
  ),
  triangle: (
    <Art>
      <path d="M8 15H38" strokeWidth="1.8" />
      <path d="M48 15L37 9V21Z" fill="currentColor" strokeWidth="1" />
    </Art>
  ),
};

export const EDGE_COLOUR_ART = {
  source: (
    <Art>
      <rect x="6" y="8" width="16" height="14" rx="3" fill="var(--dc-accent-teal-fill)" stroke="var(--dc-accent-teal-line)" strokeWidth="1.5" />
      <path d="M22 15H42" stroke="var(--dc-accent-teal-line)" strokeWidth="1.8" />
      <path d="M50 15L41 10.5V19.5Z" fill="var(--dc-accent-teal-line)" stroke="var(--dc-accent-teal-line)" strokeWidth="1" />
    </Art>
  ),
  plain: (
    <Art>
      <rect x="6" y="8" width="16" height="14" rx="3" fill="var(--dc-accent-teal-fill)" stroke="var(--dc-accent-teal-line)" strokeWidth="1.5" />
      <path d="M22 15H42" strokeWidth="1.8" />
      <path d="M50 15L41 10.5V19.5Z" fill="currentColor" strokeWidth="1" />
    </Art>
  ),
};
