function required(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing server configuration: ${key}`);
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
  if (!response.ok) throw new Error(`Google authentication failed (${response.status}); check server OAuth credentials.`);
  const data = await response.json();
  if (typeof data.access_token !== 'string') throw new Error('Google did not return an access token.');
  cached = { token: data.access_token, key: client + refresh, until: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000 };
  return cached.token;
}
export async function adsRequest(path: string, body?: object) {
  const version = process.env.GOOGLE_ADS_API_VERSION || 'v25';
  if (!/^v\d+$/.test(version)) throw new Error('Invalid Google Ads API version.');
  const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}`,
    'developer-token': required('GOOGLE_ADS_DEVELOPER_TOKEN'), 'Content-Type': 'application/json' };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers['login-customer-id'] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replaceAll('-', '');
  const response = await fetch(`https://googleads.googleapis.com/${version}/${path}`, {
    method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store', signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Google Ads API failed (${response.status}); request ID: ${response.headers.get('request-id') || 'unavailable'}. Check permissions, developer token, account, and query fields.`);
  return response.json();
}
export function validateQuery(query: string) {
  if (!/^\s*SELECT\s/i.test(query) || /;|--|\/\*/.test(query)) throw new Error('Only a single SELECT query is supported.');
  const limit = query.match(/\bLIMIT\s+(\d+)\s*$/i);
  if (!limit || Number(limit[1]) < 1 || Number(limit[1]) > 500) throw new Error('End the query with LIMIT 1 through LIMIT 500.');
  return query.trim();
}
export async function searchAds(id: string, query: string) {
  const data = await adsRequest(`customers/${id}/googleAds:search`, { query: validateQuery(query) });
  return { rows: data.results || [], next_page_token: data.nextPageToken || null,
    query, extracted_at: new Date().toISOString() };
}
export function validateDates(start: string, end: string) {
  for (const d of [start, end]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d) throw new Error('Dates must be valid YYYY-MM-DD dates.');
  }
  if (start > end) throw new Error('Start date must precede end date.');
}
export async function accountReport(id: string, start: string, end: string) {
  validateDates(start, end);
  const query = `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM customer WHERE segments.date BETWEEN '${start}' AND '${end}' LIMIT 1`;
  const result = await searchAds(id, query);
  const row = result.rows[0];
  if (!row) return { ...result, report: null, note: 'No matching data; this is not a verified zero.' };
  const metrics = row.metrics || {};
  const impressions = Number(metrics.impressions || 0), clicks = Number(metrics.clicks || 0);
  const conversions = Number(metrics.conversions || 0), cost = Number(metrics.costMicros || 0) / 1_000_000;
  return { ...result, report: { customer: row.customer, start_date: start, end_date: end,
    cost, impressions, clicks, conversions, ctr: impressions ? clicks / impressions : null,
    average_cpc: clicks ? cost / clicks : null, cost_per_conversion: conversions ? cost / conversions : null },
    note: 'CTR is total clicks / total impressions. Conversions are Google Ads conversions, not CallRail qualified leads. Dates use the account time zone.' };
}
