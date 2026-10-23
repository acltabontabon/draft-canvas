export function checkCloudflareTls(options: {
  zoneId?: string;
  token?: string;
  request?: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
}): Promise<{ min_tls_version: string; tls_1_3: string; compliant: boolean }>;
