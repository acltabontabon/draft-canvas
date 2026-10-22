/**
 * Whether two document values mean the same thing, as JSON would see them.
 *
 * Operations share unchanged structure, so identity answers almost every comparison; this is what
 * answers the rest. A key holding `undefined` counts as absent, because that is what it becomes on
 * the wire — a value that only differs in one would otherwise look changed forever on one side.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    // NaN never reaches a document (validation clamps every number), so plain equality suffices.
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let count = 0;
  for (const key in left) {
    if (!Object.prototype.hasOwnProperty.call(left, key) || left[key] === undefined) continue;
    count += 1;
    if (!Object.prototype.hasOwnProperty.call(right, key) || !sameValue(left[key], right[key])) return false;
  }
  for (const key in right) {
    if (Object.prototype.hasOwnProperty.call(right, key) && right[key] !== undefined) count -= 1;
  }
  return count === 0;
}

/**
 * `sameValue` for two nodes, ignoring what is inside them: a node whose room changed is a new object
 * with the same own fields, and is not itself a change.
 */
export function sameExcept(a: Record<string, unknown>, b: Record<string, unknown>, ignored: string): boolean {
  if (a === b) return true;
  let count = 0;
  for (const key in a) {
    if (key === ignored || !Object.prototype.hasOwnProperty.call(a, key) || a[key] === undefined) continue;
    count += 1;
    if (!Object.prototype.hasOwnProperty.call(b, key) || !sameValue(a[key], b[key])) return false;
  }
  for (const key in b) {
    if (key !== ignored && Object.prototype.hasOwnProperty.call(b, key) && b[key] !== undefined) count -= 1;
  }
  return count === 0;
}
