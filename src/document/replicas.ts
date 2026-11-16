/**
 * A Service's replica count — how many instances of it run. Typed as part of its name
 * ("Fulfilment ×3", "Fulfilment x3") and stored apart from it (`DraftNode.replicas`), so the name
 * stays the name and the count is drawn as a small mark and read by Traffic.
 */

import { LIMITS } from './limits';

/** "Fulfilment ×3" → name "Fulfilment", count 3. The × may sit against the name; a plain x must
 *  stand apart from it, so a name like "Redux3" or "Box 2" is left alone. `null` when the name
 *  carries no count. A count of 1 is returned as such: typing ×1 is how a count is taken off. */
export function splitReplicaCount(text: string): { name: string; count: number } | null {
  const match = /^(.*?\S)\s*[×✕]\s*(\d{1,3})\s*$/.exec(text) ?? /^(.*?\S)\s+[xX]\s?(\d{1,3})\s*$/.exec(text);
  if (!match) return null;
  const count = Number(match[2]);
  if (!Number.isInteger(count) || count < 1) return null;
  return { name: match[1]!, count: Math.min(count, LIMITS.maxReplicas) };
}

/** The stored form of a count: absent for one instance. */
export function replicasField(count: number | undefined): number | undefined {
  return count !== undefined && count >= 2 ? Math.min(Math.round(count), LIMITS.maxReplicas) : undefined;
}
