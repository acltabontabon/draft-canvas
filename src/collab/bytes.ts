/** UTF-8 bytes on the wire. Ordinary JSON is ASCII, so count it without allocating an encoded copy. */
export function utf8Bytes(text: string): number {
  return /^[ -~\n\r\t]*$/.test(text) ? text.length : new TextEncoder().encode(text).byteLength;
}
