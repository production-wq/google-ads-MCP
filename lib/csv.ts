import { sheetBudgetCsv } from './google-sheet';
import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { get } from '@vercel/blob';

export const MAX_CSV_BYTES = 2_000_000;
export type Account = {
  row: number; name: string; customer_id: string;
  target_spend: number | null; target_spend_raw: string; comments: string;
};
export function customerId(value: string): string {
  if (!/^(?:\d{10}|\d{3}-\d{3}-\d{4})$/.test(value.trim())) throw new Error('Invalid customer ID.');
  return value.trim().replaceAll('-', '');
}
export function parseBudget(text: string) {
  if (Buffer.byteLength(text) > MAX_CSV_BYTES) throw new Error('CSV exceeds 2 MB limit.');
  const rows = parse(text, { bom: true, skip_empty_lines: true, relax_column_count: true, max_record_size: 100_000 }) as string[][];
  const header = rows.findIndex(r => r.some(c => c.trim() === 'Customer ID') && r.some(c => c.trim() === 'Account name'));
  if (header < 0) throw new Error('CSV must contain Account name, Customer ID, and Ad target spend headers.');
  const names = rows[header].map(c => c.trim());
  const nameIndex = names.indexOf('Account name'), idIndex = names.indexOf('Customer ID');
  const budgetIndex = names.indexOf('Ad target spend'), commentsIndex = names.indexOf('Comments');
  if (budgetIndex < 0) throw new Error('Missing Ad target spend column.');
  const seen = new Set<string>();
  const accounts: Account[] = [];
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i], rawId = (r[idIndex] ?? '').trim();
    if (!rawId && !r[nameIndex]?.trim()) continue;
    const id = customerId(rawId);
    if (seen.has(id)) throw new Error(`Duplicate customer ID at CSV row ${i + 1}.`);
    seen.add(id);
    const raw = (r[budgetIndex] ?? '').trim();
    const numeric = /^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw);
    accounts.push({ row: i + 1, name: r[nameIndex]?.trim() ?? '', customer_id: id,
      target_spend: numeric ? Number(raw.replace(/[$,]/g, '')) : null,
      target_spend_raw: raw, comments: commentsIndex < 0 ? '' : (r[commentsIndex] ?? '') });
  }
  if (!accounts.length) throw new Error('CSV contains no accounts.');
  return { version: createHash('sha256').update(text).digest('hex'), accounts };
}

export async function loadBudget() {
  let text: string;
  if (process.env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    text = await sheetBudgetCsv();
  } else if (process.env.CSV_LOCAL_PATH && !process.env.VERCEL) {
    text = await readFile(process.env.CSV_LOCAL_PATH, 'utf8');
  } else {
    const blob = await get(process.env.CSV_BLOB_PATH || 'worksheets/budget.csv', {
      access: 'private', useCache: false,
    });
    if (!blob || blob.statusCode !== 200) throw new Error('Budget CSV unavailable. Upload the CSV to the configured private Blob store.');
    if (blob.blob.size > MAX_CSV_BYTES) throw new Error('CSV exceeds 2 MB limit.');
    text = await new Response(blob.stream).text();
  }
  return { ...parseBudget(text), fetched_at: new Date().toISOString() };
}

export function assertVersion(actual: string, expected?: string) {
  if (expected && actual !== expected) throw new Error('CSV changed during this report. Reload accounts and restart with the new version.');
}

export function authorizedAccount(accounts: Account[], input: string): Account {
  const id = customerId(input);
  const allowed = (process.env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS || '').split(',').filter(Boolean).map(customerId);
  if (!allowed.length || !allowed.includes(id)) throw new Error('Account not in deployment allowlist.');
  const account = accounts.find(a => a.customer_id === id);
  if (!account) throw new Error('Account not in current CSV.');
  return account;
}
