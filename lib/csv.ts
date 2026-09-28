import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { get } from '@vercel/blob';
import { SafeError } from './errors';

export const MAX_CSV_BYTES = 2_000_000;
export type Account = {
  row: number; name: string; customer_id: string;
  target_spend: number | null; target_spend_raw: string; comments: string;
  /** Present only when the source has a status column. */
  status?: string;
};
export function customerId(value: string): string {
  if (!/^(?:\d{10}|\d{3}-\d{3}-\d{4})$/.test(value.trim())) throw new SafeError('Invalid customer ID.');
  return value.trim().replaceAll('-', '');
}

/**
 * Column names as they appear across the master sheet's tabs and the older CSV
 * export. Matching is case-insensitive, so "Account name" and "Account Name"
 * both work. Add a spelling here when a tab uses a new one.
 */
const COLUMNS = {
  name: ['account name'],
  id: ['customer id', 'cid'],
  target: ['ad target spend', 'ppc target (zoho)', 'ppc target', 'monthly budget', 'target spend', 'google ads budget (calc)'],
  comments: ['comments', 'notes', 'budget notes (shared budgets: $/day and campaigns)', 'budget notes'],
  status: ['ppc status', 'zoho status', 'status'],
} as const;
const findColumn = (header: string[], synonyms: readonly string[]) =>
  header.findIndex(cell => synonyms.includes(cell.trim().toLowerCase()));

/**
 * Shared by the CSV export and every tab of the Google Sheet. Preamble rows
 * above the header and extra columns are tolerated, so a tab can grow new
 * columns without breaking this.
 */
export function parseAccountRows(rows: string[][]) {
  const cell = (r: string[] | undefined, i: number) => (i < 0 ? '' : String(r?.[i] ?? ''));
  const header = rows.findIndex(r => {
    const cells = r.map(c => String(c).trim().toLowerCase());
    return COLUMNS.id.some(n => cells.includes(n)) && COLUMNS.name.some(n => cells.includes(n));
  });
  if (header < 0) throw new SafeError('Source must contain an account name column and a customer ID column ("Customer ID" or "CID").');
  const names = rows[header].map(c => String(c).trim());
  const nameIndex = findColumn(names, COLUMNS.name), idIndex = findColumn(names, COLUMNS.id);
  const budgetIndex = findColumn(names, COLUMNS.target), commentsIndex = findColumn(names, COLUMNS.comments);
  const statusIndex = findColumn(names, COLUMNS.status);
  if (budgetIndex < 0) throw new SafeError(`Source has no budget column. Expected one of: ${COLUMNS.target.join(', ')}.`);

  const seen = new Map<string, number>();
  const accounts: Account[] = [];
  const duplicates: { customer_id: string; row: number; kept_row: number }[] = [];
  const skipped: { row: number; value: string }[] = [];
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i], rawId = cell(r, idIndex).trim();
    if (!rawId && !cell(r, nameIndex).trim()) continue;
    let id: string;
    // A living sheet accumulates subtotal and note rows; skip them instead of failing the whole read.
    try { id = customerId(rawId); } catch { skipped.push({ row: i + 1, value: rawId.slice(0, 40) }); continue; }
    if (seen.has(id)) { duplicates.push({ customer_id: id, row: i + 1, kept_row: seen.get(id)! }); continue; }
    seen.set(id, i + 1);
    const raw = cell(r, budgetIndex).trim();
    const numeric = /^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw);
    const status = statusIndex < 0 ? undefined : cell(r, statusIndex).trim() || undefined;
    accounts.push({ row: i + 1, name: cell(r, nameIndex).trim(), customer_id: id,
      target_spend: numeric ? Number(raw.replace(/[$,]/g, '')) : null,
      target_spend_raw: raw, comments: cell(r, commentsIndex), ...(status ? { status } : {}) });
  }
  if (!accounts.length) throw new SafeError('Source contains no accounts.');
  return { accounts, duplicates, skipped, columns: { name: names[nameIndex], id: names[idIndex],
    target: names[budgetIndex], comments: commentsIndex < 0 ? null : names[commentsIndex],
    status: statusIndex < 0 ? null : names[statusIndex] } };
}

export function parseBudget(text: string) {
  if (Buffer.byteLength(text) > MAX_CSV_BYTES) throw new SafeError('CSV exceeds 2 MB limit.');
  const rows = parse(text, { bom: true, skip_empty_lines: true, relax_column_count: true, max_record_size: 100_000 }) as string[][];
  return { version: createHash('sha256').update(text).digest('hex'), ...parseAccountRows(rows) };
}

export async function loadBudget() {
  let text: string;
  if (process.env.CSV_LOCAL_PATH && !process.env.VERCEL) {
    text = await readFile(process.env.CSV_LOCAL_PATH, 'utf8');
  } else {
    const blob = await get(process.env.CSV_BLOB_PATH || 'worksheets/budget.csv', {
      access: 'private', useCache: false,
    });
    if (!blob || blob.statusCode !== 200) throw new SafeError('Budget CSV unavailable. Upload the CSV to the configured private Blob store.');
    if (blob.blob.size > MAX_CSV_BYTES) throw new SafeError('CSV exceeds 2 MB limit.');
    text = await new Response(blob.stream).text();
  }
  return { ...parseBudget(text), fetched_at: new Date().toISOString(), source: 'csv' as const };
}

export function assertVersion(actual: string, expected?: string) {
  if (expected && actual !== expected) throw new SafeError('Source changed during this report. Reload accounts and restart with the new version.');
}

export function authorizedAccount(accounts: Account[], input: string): Account {
  const id = customerId(input);
  const allowed = (process.env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS || '').split(',').filter(Boolean).map(customerId);
  if (!allowed.length || !allowed.includes(id)) throw new SafeError('Account not in deployment allowlist.');
  const account = accounts.find(a => a.customer_id === id);
  if (!account) throw new SafeError('Account not in current worksheet.');
  return account;
}
