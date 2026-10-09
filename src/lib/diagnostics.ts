import { CURRENT_VERSION } from '../document/types';
import { PRODUCT } from '../product';

export interface DiagnosticContext {
  /** Short, stable tag for where this came from, e.g. 'canvas-render', 'app-shell'. */
  operation: string;
  documentId?: string | null;
  flowId?: string | null;
  nodeIds?: string[];
  edgeIds?: string[];
}

const OPERATIONS = new Set([
  'about-panel', 'app-shell', 'export-panel', 'canvas-render', 'autosave',
  'desktop-open-external', 'desktop-report-state',
]);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'QuotaExceededError', 'SecurityError', 'InvalidStateError']);
const MAX_EVENTS = 20;

interface DiagnosticEvent {
  at: string;
  operation: string;
  errorType: string;
  nodeCount?: number;
  edgeCount?: number;
}

const events: DiagnosticEvent[] = [];

/** Errors can echo document text or paths. Only a closed vocabulary and counts reach a report. */
export function logDiagnostic(error: unknown, context: DiagnosticContext, componentStack?: string): void {
  const event: DiagnosticEvent = {
    at: new Date().toISOString(),
    operation: OPERATIONS.has(context.operation) ? context.operation : 'other',
    errorType: error instanceof Error && ERROR_NAMES.has(error.name) ? error.name : 'UnknownError',
    ...(context.nodeIds ? { nodeCount: context.nodeIds.length } : {}),
    ...(context.edgeIds ? { edgeCount: context.edgeIds.length } : {}),
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
  if (import.meta.env.DEV) {
    console.error(`[draft-canvas:${context.operation}]`, error, context, componentStack);
    return;
  }
  console.error('[draft-canvas] Unexpected failure', event);
}

/** Memory only, until the person previews and downloads it. No URLs, stacks, ids or diagram content. */
export function diagnosticReport(): string {
  return JSON.stringify({
    format: 1,
    appVersion: PRODUCT.version,
    schemaVersion: CURRENT_VERSION,
    generatedAt: new Date().toISOString(),
    events,
  }, null, 2);
}
