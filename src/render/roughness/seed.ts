/**
 * A tiny deterministic PRNG keyed off a stable string id — never
 * `Math.random()` or wall-clock. Same id in, same numbers out, forever. This
 * is what lets `nodes/describe.ts`/`edges/describe.ts` keep their existing
 * "same input, same shapes out" invariant even with jitter turned on: the
 * same node/edge always wobbles the same way, so switching presets and
 * re-rendering is stable, testable, and safe to export headlessly.
 */
function hashSeed(id: string): number {
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for visual jitter; not cryptographic. */
export function createRng(seedString: string): () => number {
  let state = hashSeed(seedString);
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A jitter offset in `[-amplitude, amplitude]`, deterministic per
 * `(seedString, index)`. Re-seeds on every call rather than sharing one RNG
 * across a sequence of indices, so index 0's value never depends on how many
 * other values were drawn before it — reordering which corner/vertex a
 * caller computes first can never change any individual jitter value.
 */
export function jitter(seedString: string, index: number, amplitude: number): number {
  if (amplitude === 0) return 0;
  const rng = createRng(`${seedString}:${index}`);
  return (rng() * 2 - 1) * amplitude;
}
