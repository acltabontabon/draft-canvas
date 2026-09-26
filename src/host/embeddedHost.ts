import type { AgentEditorReply, AgentEditorRequest } from './agentBridge';

/**
 * Messages between the app and the host that owns its file — today the desktop shell, in the same
 * page (`src/desktop/channel.ts`). The message names and shapes are the ones the retired VS Code
 * extension spoke too, kept as they were: nothing depends on the numbering any more, and renaming
 * them would only churn the desktop's own tests.
 */
export type ToHostMessage =
  /** `baseSeq`: the `seq` of the load this edit was made on top of. */
  | { type: 'draft-canvas:change'; text: string; baseSeq?: number }
  | { type: 'draft-canvas:save'; saveAs: boolean }
  /** A link the host opens in the system browser. */
  | { type: 'draft-canvas:open-external'; url: string }
  /**
   * Only to a host whose load said `background`: the canvas's background image as it stands now
   * (base64), for the host to keep beside the file. It says so again on every change.
   */
  | { type: 'draft-canvas:background-write'; mime: string; data: string }
  /** Likewise: the canvas no longer has a background image. */
  | { type: 'draft-canvas:background-remove' }
  /** Likewise: asks for the file's stored image, answered by a `BackgroundMessage` with this `id`. */
  | { type: 'draft-canvas:background-read'; id: number }
  /** The open document was closed — Home is showing. */
  | { type: 'draft-canvas:closed' }
  /** The answer to a `flush` command, once the app has posted every edit still pending. */
  | { type: 'draft-canvas:flushed'; id: number }
  /** The answer to an `agent` command (see `host/agentBridge.ts`). */
  | { type: 'draft-canvas:agent'; id: number; reply: AgentEditorReply };

/**
 * Desktop shell to app. `flush` has the app let go of a field still being typed in and post what is
 * pending, so the shell acts on exactly what is on screen; `close` leaves the open document for Home.
 */
export interface CommandMessage {
  type: 'draft-canvas:command';
  /** `agent`: an AI agent's question or change for the open document. */
  command: 'flush' | 'close' | 'agent';
  id?: number;
  request?: AgentEditorRequest;
}

/** The host's answer to `background-read`: the stored image (base64), or none when the file has no image beside it. */
export interface BackgroundMessage {
  type: 'draft-canvas:background';
  id: number;
  mime?: string;
  data?: string;
}

export interface LoadMessage {
  type: 'draft-canvas:load';
  /** The file's contents. Empty means a new file, which gets a fresh document. */
  text: string;
  /** The file's name without its extension, used as the title of a new document. */
  title?: string;
  /**
   * Counts up with every load the host sends. A change carries back the `seq` it was made on
   * (`baseSeq`), so when the file was replaced from outside (a revert, a reload) while an edit was on
   * its way, the host can drop that edit instead of writing the old contents over the new ones.
   */
  seq?: number;
  /**
   * The host keeps the canvas's background image beside the file. The app asks for it
   * (`background-read`) when the file turns one on that it doesn't hold, and reports each change.
   */
  background?: boolean;
}
