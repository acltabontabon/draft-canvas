import { ALT_SYMBOL, MOD_SYMBOL } from '../../lib/platform';
import type { KeyName } from '../../learn/types';

const IS_MAC_SYMBOLS = MOD_SYMBOL === '⌘';

const NAMED: Record<string, string> = {
  mod: MOD_SYMBOL,
  alt: ALT_SYMBOL,
  shift: IS_MAC_SYMBOLS ? '⇧' : 'Shift',
  enter: '↵',
  esc: 'Esc',
  tab: 'Tab',
  right: '→',
  left: '←',
  up: '↑',
  down: '↓',
  space: 'Space',
};

const SPOKEN: Record<string, string> = {
  mod: IS_MAC_SYMBOLS ? 'Command' : 'Control',
  alt: IS_MAC_SYMBOLS ? 'Option' : 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  esc: 'Escape',
  tab: 'Tab',
  right: 'Right arrow',
  left: 'Left arrow',
  ']': 'Right bracket',
  '[': 'Left bracket',
};

export function keyCap(key: KeyName): string {
  return NAMED[key] ?? key.toUpperCase();
}

export function spokenKeys(keys: readonly KeyName[]): string {
  return keys.map((key) => SPOKEN[key] ?? key.toUpperCase()).join(' ');
}
