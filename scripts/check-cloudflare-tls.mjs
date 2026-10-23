// Read-only check of the zone settings managed outside Wrangler. This never changes Cloudflare.
import { pathToFileURL } from 'node:url';

export async function checkCloudflareTls({ zoneId, token, request = fetch }) {
  if (!/^[a-f0-9]{32}$/i.test(zoneId ?? '') || !token?.trim()) {
    throw new Error('Set CLOUDFLARE_ZONE_ID and CLOUDFLARE_TLS_API_TOKEN (Zone Read and Zone Settings Read, draftcanvas.dev only).');
  }

  async function read(path) {
    let response;
    let body;
    try {
      response = await request(`https://api.cloudflare.com/client/v4/zones/${zoneId}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      body = await response.json();
    } catch {
      // Do not print request objects or API bodies: they can contain credentials or account data.
      throw new Error(`Could not read Cloudflare zone${path}; check connectivity and token permissions.`);
    }
    if (!response.ok || body?.success !== true || !body.result) {
      throw new Error(`Cloudflare zone${path} read failed (HTTP ${response.status}); check token permissions.`);
    }
    return body.result;
  }

  const zone = await read('');
  if (zone.name !== 'draftcanvas.dev') throw new Error('CLOUDFLARE_ZONE_ID must identify draftcanvas.dev.');

  const values = {};
  for (const id of ['min_tls_version', 'tls_1_3']) {
    const setting = await read(`/settings/${id}`);
    if (setting.id !== id || typeof setting.value !== 'string') {
      throw new Error(`Unexpected Cloudflare ${id} response.`);
    }
    values[id] = setting.value;
  }

  return {
    ...values,
    // zrt also enables TLS 1.3. Checking TLS versions must not require changing an existing 0-RTT setting.
    compliant: values.min_tls_version === '1.2' && ['on', 'zrt'].includes(values.tls_1_3),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-cloudflare-tls.mjs (read-only; no arguments)');
    const result = await checkCloudflareTls({
      zoneId: process.env.CLOUDFLARE_ZONE_ID,
      token: process.env.CLOUDFLARE_TLS_API_TOKEN,
    });
    console.log(`draftcanvas.dev zone: min_tls_version=${result.min_tls_version}, tls_1_3=${result.tls_1_3}`);
    console.log('Zone settings only; hostname overrides and live edge negotiation still need verification.');
    if (!result.compliant) throw new Error('Expected minimum TLS 1.2 with TLS 1.3 enabled. Follow docs/reference/website.md#edge-tls-policy.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
