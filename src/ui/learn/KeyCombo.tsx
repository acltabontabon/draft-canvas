import type { KeyName } from '../../learn/types';
import { keyCap, spokenKeys } from './keys';

/** A key combination as caps. The caps are decoration; the accessible name is spelled out. */
export function KeyCombo({ keys }: { keys: readonly KeyName[] }) {
  return (
    <span className="dc-learn-combo" aria-label={spokenKeys(keys)} role="img">
      {keys.map((key, i) => (
        <kbd key={`${key}-${i}`} aria-hidden="true">
          {keyCap(key)}
        </kbd>
      ))}
    </span>
  );
}
