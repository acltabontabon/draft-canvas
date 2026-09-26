import type { ToHostMessage } from './embeddedHost';

/**
 * The line between the app and whatever owns its file: today the desktop shell, in this same page
 * (once also a VS Code webview across a frame, before that extension was retired). `useHostDocument`
 * speaks only this, so what the app says to a host — and what a host may say back — does not depend
 * on which one is on the other end.
 */
export interface HostChannel {
  readonly kind: 'desktop';
  /**
   * Starts listening. `onMessage` receives every message the host sent that has passed this
   * channel's own check of who sent it. Returns a function that stops listening.
   */
  start(onMessage: (data: unknown) => void): () => void;
  post(message: ToHostMessage): void;
  /**
   * In-process hosts only, not a wire message. Called once the app has opened what a `load` carried,
   * with that document as the app itself serializes it — which is what the host must compare later
   * edits with to know whether the file is dirty (an older file's raw text never equals it).
   */
  opened?(info: { text: string; seq?: number }): void;
}
