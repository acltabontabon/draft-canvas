import { CURRENT_VERSION } from '../document/types';

export interface DiagnosticContext {
  /** Short, stable tag for where this came from, e.g. 'canvas-render', 'app-shell'. */
  operation: string;
  documentId?: string | null;
  flowId?: string | null;
  nodeIds?: string[];
  edgeIds?: string[];
}

/**
 * One shared shape for an unexpected-failure log line. Full detail (the raw
 * error, context, component stack) in development; in production, one
 * low-cardinality line — ids and counts only, never node/edge text, so a
 * user's actual diagram content never reaches the console.
 */
export function logDiagnostic(error: unknown, context: DiagnosticContext, componentStack?: string): void {
  if (import.meta.env.DEV) {
    console.error(`[draft-canvas:${context.operation}]`, error, context, componentStack);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[draft-canvas:${context.operation}] ${message}`, {
    documentId: context.documentId ?? null,
    flowId: context.flowId ?? null,
    nodeCount: context.nodeIds?.length,
    edgeCount: context.edgeIds?.length,
    schemaVersion: CURRENT_VERSION,
  });
}
