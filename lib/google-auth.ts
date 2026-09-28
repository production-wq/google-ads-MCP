import { SafeError } from './errors';

/**
 * One user refresh token carries both scopes, so Google Ads and Google Sheets
 * share a single consent, a single access token and a single cache entry.
 * Consent must be granted with BOTH scopes or Sheets calls return 403.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/spreadsheets',
];

export function required(key: string) {
  const value = process.env[key];
  if (!value) throw new SafeError(`Missing server configuration: ${key}`);
  return value;
}

let cached: { token: string; until: number; key: string } | undefined;
export async function accessToken() {
  const client = required('GOOGLE_ADS_CLIENT_ID');
  const refresh = required('GOOGLE_ADS_REFRESH_TOKEN');
  if (cached && cached.until > Date.now() && cached.key === client + refresh) return cached.token;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ client_id: client, client_secret: required('GOOGLE_ADS_CLIENT_SECRET'),
      refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  if (!response.ok) throw new SafeError(`Google authentication failed (${response.status}); check server OAuth credentials.`);
  const data = await response.json();
  if (typeof data.access_token !== 'string') throw new SafeError('Google did not return an access token.');
  cached = { token: data.access_token, key: client + refresh, until: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000 };
  return cached.token;
}

/** Authenticated Google API call. Never caches; always bounded by a timeout. */
export async function googleFetch(url: string, init: {
  method?: string; body?: object; headers?: Record<string, string>; timeout?: number;
} = {}) {
  return fetch(url, {
    method: init.method || (init.body ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store', signal: AbortSignal.timeout(init.timeout ?? 25_000),
  });
}
