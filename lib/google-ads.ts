import { SafeError } from './errors';
import { googleFetch, required } from './google-auth';

function apiVersion() {
  const version = process.env.GOOGLE_ADS_API_VERSION || 'v25';
  if (!/^v\d+$/.test(version)) throw new SafeError('Invalid Google Ads API version.');
  return version;
}
function adsHeaders() {
  const headers: Record<string, string> = { 'developer-token': required('GOOGLE_ADS_DEVELOPER_TOKEN') };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers['login-customer-id'] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replaceAll('-', '');
  return headers;
}

/**
 * Google's own field-level validation messages, which describe the caller's
 * request rather than server internals, so they are safe to show. Anything the
 * extractor does not recognise is dropped rather than echoed.
 */
function validationDetail(payload: unknown): string {
  const seen: string[] = [];
  const error = (payload as { error?: { details?: unknown[] } } | undefined)?.error;
  for (const detail of error?.details ?? []) {
    for (const item of (detail as { errors?: unknown[] }).errors ?? []) {
      const entry = item as { message?: unknown; errorCode?: Record<string, unknown>; location?: { fieldPathElements?: { fieldName?: string }[] } };
      if (typeof entry.message !== 'string') continue;
      const code = Object.values(entry.errorCode ?? {}).find(v => typeof v === 'string');
      const field = entry.location?.fieldPathElements?.map(f => f.fieldName).filter(Boolean).join('.');
      seen.push([code, field, entry.message].filter(Boolean).join(' | ').slice(0, 300));
    }
  }
  return seen.slice(0, 10).join(' ;; ');
}

export async function adsRequest(path: string, body?: object) {
  const response = await googleFetch(`https://googleads.googleapis.com/${apiVersion()}/${path}`, { body, headers: adsHeaders() });
  if (!response.ok) {
    const detail = validationDetail(await response.json().catch(() => undefined));
    throw new SafeError(`Google Ads API failed (${response.status}); request ID: ${response.headers.get('request-id') || 'unavailable'}.`
      + (detail ? ` Google reported: ${detail}` : ' Check permissions, developer token, account, and query fields.'));
  }
  return response.json();
}

/**
 * A mutate call. `validateOnly` asks Google to check the operations and change
 * nothing, which is what the preview step of every write tool uses.
 * `partialFailure` stays false so a batch either fully applies or fully fails.
 */
export async function adsMutate(customerId: string, resource: string, operations: object[], validateOnly: boolean) {
  if (!operations.length) throw new SafeError('No operations to apply.');
  return adsRequest(`customers/${customerId}/${resource}:mutate`, {
    operations, validateOnly, partialFailure: false,
    responseContentType: validateOnly ? 'RESOURCE_NAME_ONLY' : 'MUTABLE_RESOURCE',
  });
}

/** Atomic multi-resource mutate, used where one change spans resources (budget + campaign). */
export async function adsMutateAtomic(customerId: string, mutateOperations: object[], validateOnly: boolean) {
  if (!mutateOperations.length) throw new SafeError('No operations to apply.');
  return adsRequest(`customers/${customerId}/googleAds:mutate`, {
    mutateOperations, validateOnly, partialFailure: false,
    responseContentType: validateOnly ? 'RESOURCE_NAME_ONLY' : 'MUTABLE_RESOURCE',
  });
}

export function validateQuery(query: string) {
  if (!/^\s*SELECT\s/i.test(query) || /;|--|\/\*/.test(query)) throw new SafeError('Only a single SELECT query is supported.');
  const limit = query.match(/\bLIMIT\s+(\d+)\s*$/i);
  if (!limit || Number(limit[1]) < 1 || Number(limit[1]) > 500) throw new SafeError('End the query with LIMIT 1 through LIMIT 500.');
  return query.trim();
}
export async function searchAds(id: string, query: string) {
  const data = await adsRequest(`customers/${id}/googleAds:search`, { query: validateQuery(query) });
  return { rows: data.results || [], next_page_token: data.nextPageToken || null,
    query, extracted_at: new Date().toISOString() };
}
/** Internal reads that build their own bounded GAQL, bypassing caller-facing checks. */
export async function searchRows(id: string, query: string): Promise<Record<string, any>[]> {
  const data = await adsRequest(`customers/${id}/googleAds:search`, { query });
  return data.results || [];
}
export function validateDates(start: string, end: string) {
  for (const d of [start, end]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d) throw new SafeError('Dates must be valid YYYY-MM-DD dates.');
  }
  if (start > end) throw new SafeError('Start date must precede end date.');
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
