/**
 * The failures an agent can be told about, each with a stable code to branch on. The bridge
 * (`src-tauri/src/agent/broker.rs`) passes through only the codes it lists, so a new one is added in
 * both places — and in `docs/reference/agent-integration.md`, where agents read what they mean.
 */

export type AgentErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_TYPE'
  | 'INVALID_REFERENCE'
  | 'DUPLICATE_ID'
  | 'CONTAINMENT_CYCLE'
  | 'REVISION_CONFLICT'
  | 'CURSOR_STALE'
  | 'LIMIT_EXCEEDED'
  | 'LAYOUT_FAILED'
  | 'LAYOUT_CONSTRAINED'
  | 'DUPLICATE_FLOW'
  | 'OUT_OF_SCOPE'
  | 'SCOPE_TARGET_MISSING'
  | 'CANCELLED'
  | 'NOT_ACTIVE'
  | 'DOCUMENT_BUSY'
  | 'BUSY'
  | 'READ_ONLY'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export interface AgentErrorJson {
  code: AgentErrorCode;
  message: string;
  hint?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AgentErrorCode,
    message: string,
    extra: { hint?: string; retryable?: boolean; details?: Record<string, unknown>; path?: string } = {},
  ) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.hint = extra.hint;
    this.retryable = extra.retryable;
    const details = { ...(extra.details ?? {}), ...(extra.path !== undefined ? { path: extra.path } : {}) };
    this.details = Object.keys(details).length ? details : undefined;
  }

  toJSON(): AgentErrorJson {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.retryable ? { retryable: true } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Anything thrown, as what an agent may be shown: an `AgentError` as it is, anything else as a
 *  bare internal failure — never its message or stack, which could carry document content. */
export function toAgentError(error: unknown): AgentErrorJson {
  if (error instanceof AgentError) return error.toJSON();
  return { code: 'INTERNAL', message: 'Draft Canvas hit an unexpected problem handling this request.' };
}

/** Collects problems found while checking a request, so one reply lists them all (up to a bound). */
export class Problems {
  private readonly list: { code: AgentErrorCode; path: string; message: string; details?: Record<string, unknown> }[] = [];
  private truncated = false;
  static readonly MAX = 20;

  add(code: AgentErrorCode, path: string, message: string, details?: Record<string, unknown>): void {
    if (this.list.length < Problems.MAX) this.list.push({ code, path, message, details });
    else this.truncated = true;
  }

  get empty(): boolean {
    return this.list.length === 0;
  }

  /**
   * Throws the first problem as the error, with every one found in `details.problems`. When every
   * problem found is a `DUPLICATE_ID`, the offending ids are also collected into
   * `details.conflictingIds` — a caller that needs to know *which* ids collided (the review panel's
   * crash-recovery check: "did this proposal's own ids already land?") reads that rather than
   * parsing an id back out of the message text. Never populated when the list was truncated at
   * `MAX`: a homogeneous first 20 proves nothing about problem 21, and that check exists precisely
   * so a genuinely mixed-cause failure is never reported as a clean, confirmable one.
   */
  throwIfAny(): void {
    const first = this.list[0];
    if (!first) return;
    const conflictingIds = !this.truncated && this.list.every((p) => p.code === 'DUPLICATE_ID')
      ? [...new Set(this.list.map((p) => p.details?.id).filter((id): id is string => typeof id === 'string'))]
      : undefined;
    throw new AgentError(first.code, this.list.length === 1 ? `${first.path}: ${first.message}` : `${this.list.length} problems; first — ${first.path}: ${first.message}`, {
      path: first.path,
      details: { problems: this.list, ...(conflictingIds?.length ? { conflictingIds } : {}) },
    });
  }
}
