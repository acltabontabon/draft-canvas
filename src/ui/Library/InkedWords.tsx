import type { ReactNode } from 'react';
import './inked-words.css';

/** Words underlined by hand: a quick double stroke in the accent that draws once on arrival. */
export function InkedWords({ children }: { children: ReactNode }) {
  return (
    <span className="dc-inked-words">
      {children}
      <InkStroke />
    </span>
  );
}

/** The stroke on its own, for words it can't wrap — the editor's title, an editable field. */
export function InkStroke({ className }: { className?: string }) {
  return (
    <svg className={['dc-inked-words-stroke', className].filter(Boolean).join(' ')} viewBox="0 0 200 18" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path pathLength={1} d="M3 11C46 6 112 3 197 6M38 15C84 11 132 10 172 12" />
    </svg>
  );
}
