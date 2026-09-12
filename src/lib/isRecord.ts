/** A plain object (not `null`, not an array) whose fields can be read — the first check on any untrusted value. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
