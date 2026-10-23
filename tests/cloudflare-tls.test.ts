import { describe, expect, it, vi } from 'vitest';
import { checkCloudflareTls } from '../scripts/check-cloudflare-tls.mjs';

const zoneId = 'a'.repeat(32);
const token = 'test-token-never-log';
function api(minimum = '1.2', tls13 = 'on', zone = 'draftcanvas.dev') {
  return vi.fn(async (url: string, _options: RequestInit) => {
    const id = url.split('/').at(-1)!;
    const result = id === zoneId ? { name: zone } : { id, value: id === 'min_tls_version' ? minimum : tls13 };
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  });
}

describe('the read-only Cloudflare TLS policy check', () => {
  it.each(['on', 'zrt'])('allows TLS 1.2 compatibility with TLS 1.3 enabled (%s)', async (tls13) => {
    const request = api('1.2', tls13);
    expect(await checkCloudflareTls({ zoneId, token, request })).toEqual({
      min_tls_version: '1.2', tls_1_3: tls13, compliant: true,
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      `https://api.cloudflare.com/client/v4/zones/${zoneId}`,
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/min_tls_version`,
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/tls_1_3`,
    ]);
    for (const [, options] of request.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(options).not.toHaveProperty('body');
    }
  });

  it.each([['1.0', 'on'], ['1.1', 'on'], ['1.3', 'on'], ['1.2', 'off']])('rejects minimum %s / TLS 1.3 %s', async (minimum, tls13) => {
    expect((await checkCloudflareTls({ zoneId, token, request: api(minimum, tls13) })).compliant).toBe(false);
  });

  it('rejects a different zone before reading its settings', async () => {
    const request = api('1.2', 'on', 'other.example');
    await expect(checkCloudflareTls({ zoneId, token, request })).rejects.toThrow('must identify draftcanvas.dev');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('requires explicit credentials and a valid zone id without making requests', async () => {
    const request = api();
    for (const options of [{ zoneId: '', token }, { zoneId, token: '' }, { zoneId: '../other', token }]) {
      await expect(checkCloudflareTls({ ...options, request })).rejects.toThrow('Set CLOUDFLARE_ZONE_ID');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed on API errors without exposing response bodies or request errors', async () => {
    const denied = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [token] }) });
    await expect(checkCloudflareTls({ zoneId, token, request: denied })).rejects.toThrow('HTTP 403');
    const unavailable = async () => { throw new Error(token); };
    await expect(checkCloudflareTls({ zoneId, token, request: unavailable })).rejects.toThrow('check connectivity and token permissions');
  });
});
