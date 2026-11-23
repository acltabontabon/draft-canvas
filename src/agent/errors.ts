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
    this.hint = extra.hint ?? REFUSAL_HINTS[code];
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

/**
 * What to do about a refused request, by the code of its first problem. Each of these was refused
 * before anything changed, and would be refused again unchanged: an agent told only what was wrong
 * (a Junie run) sent variations of the same mistake until its action limit.
 */
const REFUSED = 'Nothing was changed. ';
const REFUSAL_HINTS: Partial<Record<AgentErrorCode, string>> = {
  INVALID_INPUT: `${REFUSED}Correct each field named in the error and send the request again. get_capabilities({tool}) has the full schema.`,
  INVALID_REFERENCE: `${REFUSED}Correct the named reference. For an existing diagram, read_diagram gives ids and view paths. For new content, use its declared id. In a batch, add it before referring to it.`,
  UNSUPPORTED_TYPE: `${REFUSED}Use a listed type (get_capabilities topics: ["types"]) and send again.`,
  DUPLICATE_ID: `${REFUSED}Ids are unique across the file. Choose another id for new content, then resend.`,
  CONTAINMENT_CYCLE: `${REFUSED}Choose a parent outside the element's own contents, then resend.`,
  LIMIT_EXCEEDED: `${REFUSED}Adjust the request to the limit in the message, then resend.`,
};

/** Collects problems found while checking a request, so one reply lists them all (up to a bound). */
export class Problems {
  private readonly list: { code: AgentErrorCode; path: string; message: string; details?: Record<string, unknown> }[] = [];
  private truncated = false;
  static readonly MAX = 20;

  add(code: AgentErrorCode, path: string, message: string, details?: Record<string, unknown>): void {
    if (this.list.length < Problems.MAX) this.list.push({ code, path, message, details });
    else this.truncated = true;
  }

  /** Adds what `more` has to say to each problem's message — context only the whole request has. */
  explain(more: (problem: { path: string; message: string }) => string | undefined): void {
    for (const problem of this.list) problem.message += more(problem) ?? '';
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
