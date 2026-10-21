import fc from 'fast-check';
import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_MS,
  CollabCodeError,
  INVITE_LIFETIME_MS,
  MAX_INVITE_CHARS,
  MAX_REPLY_CHARS,
  compactSdp,
  decodeInvite,
  decodeReply,
  encodeInvite,
  encodeReply,
  expandSdp,
  inviteFragment,
  invitePayloadFromHash,
  newNonce,
  type CompactSdp,
  type CollabCodeReason,
} from '../src/collab/transport/invite';

const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 61094 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 203.0.113.7',
  'a=candidate:3061243394 1 udp 2113937151 4b1d3a3e-8f2c-4c7a-9d51-2f0e3c6b7a10.local 61094 typ host generation 0 network-cost 999',
  'a=candidate:842163049 1 udp 1677729535 203.0.113.7 61094 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=candidate:1930240302 1 tcp 1518280447 4b1d3a3e-8f2c-4c7a-9d51-2f0e3c6b7a10.local 9 typ host tcptype active generation 0 network-cost 999',
  'a=candidate:2999745851 1 udp 2122260223 2001:DB8:0:0:0:0:0:1 51234 typ host generation 0',
  'a=candidate:1 1 udp 41885439 198.51.100.20 3478 typ relay raddr 203.0.113.7 rport 61094 generation 0',
  'a=candidate:5 2 udp 2113937150 192.0.2.1 61095 typ host generation 0',
  'a=ice-ufrag:Jx8+',
  'a=ice-pwd:3cV/rTqB0P8xYk2mN7zL4wHd',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

const FIREFOX_ANSWER = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 7004946216734473420 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=fingerprint:sha-256 0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0:0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0',
  'a=group:BUNDLE 0',
  'a=ice-options:trickle',
  'a=msid-semantic:WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:0 1 UDP 2122252543 0c4f8b2e-1d3a-4e5f-8a7b-9c0d1e2f3a4b.local 54321 typ host',
  'a=candidate:1 1 TCP 2105524479 0c4f8b2e-1d3a-4e5f-8a7b-9c0d1e2f3a4b.local 9 typ host tcptype active',
  'a=candidate:2 1 UDP 1686052863 198.51.100.44 54321 typ srflx raddr 0.0.0.0 rport 0',
  'a=sendrecv',
  'a=end-of-candidates',
  'a=ice-pwd:0a1b2c3d4e5f60718293a4b5c6d7e8f9',
  'a=ice-ufrag:9f8e7d6c',
  'a=mid:0',
  'a=setup:active',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
  '',
].join('\r\n');

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

function reasonOf(run: () => unknown): CollabCodeReason | 'no error' | 'other error' {
  try {
    run();
    return 'no error';
  } catch (error) {
    return error instanceof CollabCodeError ? error.reason : 'other error';
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('the compact session description', () => {
  it('keeps exactly what a data channel needs from a Chrome offer', () => {
    const compact = compactSdp(CHROME_OFFER);
    expect(compact.ufrag).toBe('Jx8+');
    expect(compact.pwd).toBe('3cV/rTqB0P8xYk2mN7zL4wHd');
    expect(compact.fingerprint.algorithm).toBe('sha-256');
    expect(compact.fingerprint.bytes[0]).toBe(0x7b);
    expect(compact.setup).toBe('actpass');
    expect(compact.mid).toBe('0');
    expect(compact.sctpPort).toBe(5000);
    expect(compact.maxMessageSize).toBe(262144);
    // Highest priority first; component 2 is not a data-channel candidate; IPv6 is in RFC 5952 form.
    expect(compact.candidates).toEqual([
      { type: 'host', protocol: 'udp', priority: 2122260223, address: '2001:db8::1', port: 51234 },
      { type: 'host', protocol: 'udp', priority: 2113937151, address: '4b1d3a3e-8f2c-4c7a-9d51-2f0e3c6b7a10.local', port: 61094 },
      { type: 'srflx', protocol: 'udp', priority: 1677729535, address: '203.0.113.7', port: 61094 },
      { type: 'host', protocol: 'tcp', tcpType: 'active', priority: 1518280447, address: '4b1d3a3e-8f2c-4c7a-9d51-2f0e3c6b7a10.local', port: 9 },
      { type: 'relay', protocol: 'udp', priority: 41885439, address: '198.51.100.20', port: 3478 },
    ]);
  });

  it('reads Firefox’s session-level fingerprint and upper-case transports', () => {
    const compact = compactSdp(FIREFOX_ANSWER);
    expect(compact.fingerprint.bytes).toHaveLength(32);
    expect(compact.setup).toBe('active');
    expect(compact.maxMessageSize).toBe(1073741823);
    expect(compact.candidates.map((candidate) => candidate.protocol)).toEqual(['udp', 'tcp', 'udp']);
  });

  it('rebuilds an SDP that compacts back to the same thing', () => {
    for (const sdp of [CHROME_OFFER, FIREFOX_ANSWER]) {
      const compact = compactSdp(sdp);
      const rebuilt = expandSdp(compact);
      expect(rebuilt).toMatch(/^v=0\r\n/);
      expect(rebuilt).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n');
      expect(rebuilt).toContain('a=end-of-candidates\r\n');
      expect(compactSdp(rebuilt)).toEqual(compact);
    }
    expect(expandSdp(compactSdp(CHROME_OFFER))).toContain('a=candidate:3 1 udp 1677729535 203.0.113.7 61094 typ srflx raddr 0.0.0.0 rport 0\r\n');
    expect(expandSdp(compactSdp(FIREFOX_ANSWER))).toContain('typ host tcptype active\r\n');
  });

  it('refuses a description without a data channel section', () => {
    expect(reasonOf(() => compactSdp('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-ufrag:abcd\r\n'))).toBe('unsupported');
    expect(reasonOf(() => compactSdp(CHROME_OFFER.replace('a=setup:actpass', 'a=setup:holdconn')))).toBe('unsupported');
    expect(reasonOf(() => compactSdp(CHROME_OFFER.replace(/a=fingerprint:.*\r\n/, '')))).toBe('unsupported');
  });
});

describe('invites and replies', () => {
  const offer = compactSdp(CHROME_OFFER);
  const answer = compactSdp(FIREFOX_ANSWER);
  const nonce = Uint8Array.from({ length: 16 }, (_, i) => i * 7);

  it('round-trips an invite with its nonce and a 30-minute expiry', () => {
    const { payload, expiresAt } = encodeInvite({ nonce, issuedAt: NOW + 999, offer });
    expect(payload.startsWith('1.')).toBe(true);
    expect(expiresAt).toBe(NOW + INVITE_LIFETIME_MS);
    const invite = decodeInvite(payload, NOW);
    expect(invite).toEqual({ nonce, issuedAt: NOW, expiresAt, offer });
  });

  it('carries the invite in a fragment', () => {
    const { payload } = encodeInvite({ nonce, issuedAt: NOW, offer });
    expect(invitePayloadFromHash(`#${inviteFragment(payload)}`)).toBe(payload);
    expect(invitePayloadFromHash('#d=1.abc')).toBeNull();
  });

  it('refuses an expired invite, allowing for a collaborator’s clock running ahead', () => {
    const { payload, expiresAt } = encodeInvite({ nonce, issuedAt: NOW, offer });
    expect(reasonOf(() => decodeInvite(payload, expiresAt + CLOCK_SKEW_MS))).toBe('no error');
    expect(reasonOf(() => decodeInvite(payload, expiresAt + CLOCK_SKEW_MS + 1))).toBe('expired');
  });

  it('round-trips a reply for the invite it answers', () => {
    const code = encodeReply({ nonce, answer });
    expect(decodeReply(code, { nonce, expiresAt: NOW + 1000 }, NOW)).toEqual(answer);
  });

  it('refuses a reply for another invite, an expired invite, or an invite pasted as a reply', () => {
    const code = encodeReply({ nonce, answer });
    expect(reasonOf(() => decodeReply(code, { nonce: newNonce(), expiresAt: NOW + 1000 }, NOW))).toBe('mismatch');
    expect(reasonOf(() => decodeReply(code, { nonce, expiresAt: NOW - 1 }, NOW))).toBe('expired');
    const { payload } = encodeInvite({ nonce, issuedAt: NOW, offer });
    expect(reasonOf(() => decodeReply(payload, { nonce, expiresAt: NOW + 1000 }, NOW))).toBe('mismatch');
    expect(reasonOf(() => decodeInvite(code, NOW))).toBe('mismatch');
  });

  it('refuses an answer that claims the offerer’s DTLS role, and an offer that does not', () => {
    expect(reasonOf(() => decodeReply(encodeReply({ nonce, answer: offer }), { nonce, expiresAt: NOW + 1000 }, NOW))).toBe('malformed');
    expect(reasonOf(() => decodeInvite(encodeInvite({ nonce, issuedAt: NOW, offer: answer }).payload, NOW))).toBe('malformed');
  });

  it('tolerates the line breaks and spaces chat apps add to a pasted code', () => {
    const code = encodeReply({ nonce, answer });
    const wrapped = ` ${code.slice(0, 20)}\n${code.slice(20, 50)} \r\n${code.slice(50)}\n`;
    expect(decodeReply(wrapped, { nonce, expiresAt: NOW + 1000 }, NOW)).toEqual(answer);
  });

  it('tells a newer format from a damaged one', () => {
    const code = encodeReply({ nonce, answer });
    const expected = { nonce, expiresAt: NOW + 1000 };
    expect(reasonOf(() => decodeReply(`2.${code.slice(2)}`, expected, NOW))).toBe('unsupported');
    expect(reasonOf(() => decodeReply(code.slice(0, -6), expected, NOW))).toBe('malformed');
    expect(reasonOf(() => decodeReply(`${code}AAAA`, expected, NOW))).toBe('malformed');
    expect(reasonOf(() => decodeReply('1.', expected, NOW))).toBe('malformed');
    expect(reasonOf(() => decodeReply('hello', expected, NOW))).toBe('malformed');
    expect(reasonOf(() => decodeReply(`1.${'A'.repeat(MAX_REPLY_CHARS)}`, expected, NOW))).toBe('malformed');
    // A body that says it is version 2 inside a version-1 wrapper.
    expect(reasonOf(() => decodeReply(`1.${base64Url(Uint8Array.of(0, 2, 1, ...nonce))}`, expected, NOW))).toBe('unsupported');
  });

  it('refuses a code that inflates past its cap without inflating it all', () => {
    const bomb = deflateSync(new Uint8Array(1024 * 1024), { level: 9 });
    const code = `1.${base64Url(Uint8Array.of(1, ...bomb))}`;
    expect(code.length).toBeLessThan(MAX_INVITE_CHARS);
    expect(reasonOf(() => decodeInvite(code, NOW))).toBe('malformed');
  });

  it('keeps reply codes short', () => {
    // A typical answer: mDNS host (UDP and TCP) and one server-reflexive candidate.
    const firefox = encodeReply({ nonce: newNonce(), answer });
    expect(firefox.length).toBeLessThanOrEqual(200);
    // A Chrome-shaped answer with five candidates, IPv6 and a relay among them.
    const chrome = encodeReply({ nonce: newNonce(), answer: { ...offer, setup: 'active' } });
    expect(chrome.length).toBeLessThanOrEqual(250);
    // Against the browser's own text for the same answer, under a quarter.
    expect(firefox.length * 4).toBeLessThan(FIREFOX_ANSWER.length);
  });
});

describe('decoding untrusted codes', () => {
  const expected = { nonce: new Uint8Array(16), expiresAt: NOW + 1000 };
  const decoders = [(text: string) => decodeInvite(text, NOW), (text: string) => decodeReply(text, expected, NOW)];

  it('fails only with a CollabCodeError, whatever text it is given', () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (text) => {
      for (const decode of decoders) expect(reasonOf(() => decode(text))).not.toBe('other error');
    }), { seed: 20261022, numRuns: 300 });
  });

  it('fails only with a CollabCodeError, whatever bytes a well-formed wrapper carries', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 400 }), fc.boolean(), fc.boolean(), (bytes, deflate, versioned) => {
      const body = versioned && bytes.length > 2 ? Uint8Array.of(1, bytes[0]! & 1, ...bytes.subarray(1)) : bytes;
      const packed = deflate ? Uint8Array.of(1, ...deflateSync(body)) : Uint8Array.of(0, ...body);
      for (const decode of decoders) expect(reasonOf(() => decode(`1.${base64Url(packed)}`))).not.toBe('other error');
    }), { seed: 20261022, numRuns: 400 });
  });

  it('either decodes a corrupted code to something valid or refuses it', () => {
    const { payload } = encodeInvite({ nonce: expected.nonce, issuedAt: NOW, offer: compactSdp(CHROME_OFFER) });
    fc.assert(fc.property(fc.nat(payload.length - 1), fc.constantFrom(...'ABCabc0189-_.'), (at, char) => {
      const damaged = payload.slice(0, at) + char + payload.slice(at + 1);
      expect(reasonOf(() => {
        const invite = decodeInvite(damaged, NOW);
        // Anything that does decode must still rebuild into a description the codec accepts.
        compactSdp(expandSdp(invite.offer));
      })).not.toBe('other error');
    }), { seed: 20261022, numRuns: 300 });
  });

  it('round-trips any description it can represent', () => {
    const iceString = (min: number, max: number) => fc.string({ unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'), minLength: min, maxLength: max });
    const address = fc.oneof(
      fc.ipV4(),
      fc.uuid({ version: 4 }).map((uuid) => `${uuid}.local`),
      fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }).map((groups) => groups.map((g) => g.toString(16)).join(':')),
      fc.constantFrom('turn.example.com', 'relay-1.example.net'),
    );
    const candidate = fc.record({
      type: fc.constantFrom('host', 'srflx', 'prflx', 'relay'),
      protocol: fc.constantFrom('udp', 'tcp'),
      tcpType: fc.constantFrom('active', 'passive', 'so'),
      priority: fc.integer({ min: 0, max: 0xffffffff }),
      address,
      port: fc.integer({ min: 0, max: 0xffff }),
    }).map(({ tcpType, ...rest }) => (rest.protocol === 'tcp' ? { ...rest, tcpType } : rest));
    const sdp = fc.record({
      ufrag: iceString(4, 32),
      pwd: iceString(22, 64),
      algorithm: fc.constantFrom(['sha-1', 20], ['sha-256', 32], ['sha-512', 64]),
      seed: fc.uint8Array({ minLength: 64, maxLength: 64 }),
      setup: fc.constantFrom('active', 'passive'),
      mid: fc.stringMatching(/^[A-Za-z0-9]{1,8}$/),
      sctpPort: fc.integer({ min: 1, max: 0xffff }),
      maxMessageSize: fc.integer({ min: 0, max: 0xffffffff }),
      candidates: fc.array(candidate, { maxLength: 16 }),
    });
    fc.assert(fc.property(sdp, ({ algorithm, seed, ...rest }) => {
      const answer = { ...rest, fingerprint: { algorithm: algorithm[0], bytes: seed.slice(0, algorithm[1] as number) } } as CompactSdp;
      const normalized = compactSdp(expandSdp(answer));
      const nonce = newNonce();
      expect(decodeReply(encodeReply({ nonce, answer: normalized }), { nonce, expiresAt: NOW }, NOW)).toEqual(normalized);
      expect(normalized.candidates).toHaveLength(answer.candidates.length);
    }), { seed: 20261022, numRuns: 200 });
  });
});
