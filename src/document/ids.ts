const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Short, collision-resistant, URL-safe ids. `crypto.getRandomValues` is present
 * in every browser we target and in Node 20+, so no dependency is needed.
 */
export function createId(prefix = ''): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}
