import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, sha256 } from '../../src/collab/transport/sha256';
import { PROOF_CONTEXT } from '../../src/collab/transport/socket';
import lanProof from '../fixtures/collab/lan-proof.json';

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const utf8 = (text: string) => new TextEncoder().encode(text);

describe('the page’s own SHA-256, for an insecure context without crypto.subtle', () => {
  it('matches the standard’s vectors, across block boundaries', () => {
    expect(hex(sha256(utf8('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(hex(sha256(utf8('a'.repeat(1000))))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });

  it('agrees with WebCrypto on whatever it is given', async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = crypto.getRandomValues(new Uint8Array(length));
      expect(hex(sha256(data))).toBe(hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data))));
    }
  });

  it('makes RFC 4231’s HMACs, and the same proof the desktop’s server expects', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    // `proof_for` in src-tauri/src/collab/mod.rs is held to the same file.
    expect(hmacSha256Hex(lanProof.token, PROOF_CONTEXT + lanProof.nonce)).toBe(lanProof.proof);
  });
});
