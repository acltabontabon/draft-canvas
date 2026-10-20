import type { ReactNode } from 'react';
import './inked-words.css';

/** Words underlined by hand: a quick double stroke in the accent that draws once on arrival. */
export function InkedWords({ children }: { children: ReactNode }) {
  return (
    <span className="dc-inked-words">
      {children}
      <svg className="dc-inked-words-stroke" viewBox="0 0 200 18" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path pathLength={1} d="M3 11C46 6 112 3 197 6M38 15C84 11 132 10 172 12" />
      </svg>
    </span>
  );
}
