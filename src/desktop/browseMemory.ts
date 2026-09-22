import type { BrowseScope } from './ui/DeskBrowse';

/**
 * Where Find a Diagram was left: the scope, the search, and how far down the list. A module-level
 * value rather than component state, because opening a diagram unmounts `DesktopHome` (and Browse with
 * it) entirely — the editor takes its place at the top of the app — so anything kept in `useState`
 * would already be gone by the time the person closes the diagram and comes back. Lost only on a full
 * reload, which is the same moment everything else about the session is too.
 */
export interface BrowseMemory {
  scope: BrowseScope;
  query: string;
  scrollTop: number;
}

let memory: BrowseMemory | null = null;

export function rememberBrowse(next: BrowseMemory | null): void {
  memory = next;
}

export function recallBrowse(): BrowseMemory | null {
  return memory;
}
