/**
 * The system clipboard as reached through the host, when the app is embedded in one that offers it
 * (see `LoadMessage.clipboard`). Set by `useHostDocument` once the host has said so; null otherwise.
 */
export interface HostClipboard {
  /** `plain`: text from a field rather than copied shapes (see `LoadMessage.textEditing`). */
  write: (text: string, plain?: boolean) => void;
  /** The clipboard's text, empty when it doesn't hold copied shapes (any text, for a `plain` read), or null if the host didn't answer. */
  read: (plain?: boolean) => Promise<string | null>;
}

let current: HostClipboard | null = null;

export function hostClipboard(): HostClipboard | null {
  return current;
}

export function setHostClipboard(next: HostClipboard | null): void {
  current = next;
}
