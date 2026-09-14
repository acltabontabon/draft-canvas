/**
 * The system clipboard as reached through the host, when the app is embedded in one that offers it
 * (see `LoadMessage.clipboard`). Set by `useHostDocument` once the host has said so; null otherwise.
 */
export interface HostClipboard {
  write: (text: string) => void;
  /** The clipboard's text, empty when it doesn't hold copied shapes, or null if the host didn't answer. */
  read: () => Promise<string | null>;
}

let current: HostClipboard | null = null;

export function hostClipboard(): HostClipboard | null {
  return current;
}

export function setHostClipboard(next: HostClipboard | null): void {
  current = next;
}
