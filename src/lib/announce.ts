/**
 * One voice for the app's screen-reader announcements.
 *
 * Anything that wants to say something — a selection change, a panel opening — calls `announce`;
 * `LiveAnnouncer` (mounted once, beside the toasts) subscribes and writes the words into a single
 * `aria-live` region. One region rather than one per feature, because two regions that update in
 * the same breath are read in whatever order the screen reader reaches them, and a region that
 * appears together with its first message is often not read at all.
 *
 * Debounced: a burst of selection changes (arrowing through shapes, a marquee sweeping over them)
 * would otherwise queue a sentence per change, and the listener hears the backlog long after the
 * selection has settled. Only the last message of a burst is spoken.
 */

export interface Announcement {
  text: string;
  /** Interrupts whatever is being read — for an error, never for a selection. */
  assertive: boolean;
  /** Changes with every message, so the same words twice are spoken twice. */
  seq: number;
}

type Listener = (announcement: Announcement) => void;

export const ANNOUNCE_DEBOUNCE_MS = 150;

const listeners = new Set<Listener>();
let pending: Omit<Announcement, 'seq'> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

function flush(): void {
  timer = null;
  const message = pending;
  pending = null;
  if (!message) return;
  seq += 1;
  const announcement = { ...message, seq };
  for (const listener of listeners) listener(announcement);
}

/** Say `text`. Within a burst, the last call wins; nothing is spoken until the burst settles. */
export function announce(text: string, options: { assertive?: boolean } = {}): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  pending = { text: trimmed, assertive: options.assertive ?? false };
  if (timer !== null) return;
  timer = setTimeout(flush, ANNOUNCE_DEBOUNCE_MS);
}

/** `LiveAnnouncer`'s subscription. Returns the unsubscribe. */
export function subscribeAnnouncements(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drops anything queued and forgets every listener. */
export function resetAnnouncements(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending = null;
  listeners.clear();
}
