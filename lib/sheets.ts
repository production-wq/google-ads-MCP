import { createHash } from 'node:crypto';
import { SafeError } from './errors';
import { googleFetch, required } from './google-auth';
import { parseAccountRows } from './csv';

export const MAX_SHEET_CELLS = 20_000;
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

function spreadsheetId() {
  const id = required('GOOGLE_SHEETS_SPREADSHEET_ID');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(id)) throw new SafeError('GOOGLE_SHEETS_SPREADSHEET_ID is not a valid spreadsheet ID.');
  return id;
}
export function accountsTab() { return process.env.SHEETS_ACCOUNTS_TAB || 'Budget'; }
export function auditTab() { return process.env.SHEETS_AUDIT_TAB || 'MCP Audit Log'; }

/**
 * A1 notation, optionally tab-qualified. Rejects anything that is not a plain
 * range so a tool argument cannot be used to reach another spreadsheet.
 */
const CELL = String.raw`\$?[A-Z]{1,3}\$?\d{0,7}`;
const TAB = String.raw`(?:'[^'\r\n]{1,100}'|[A-Za-z0-9 _.()\-]{1,100})`;
const A1 = new RegExp(`^(?:${TAB}(?:!${CELL}(?::${CELL})?)?|${CELL}:${CELL})$`);
export function validateRange(range: string) {
  const value = range.trim();
  if (!value || value.length > 200) throw new SafeError('Range must be 1 to 200 characters.');
  if (!A1.test(value)) throw new SafeError('Range must be A1 notation, such as "Budget" or "\'MCP Audit Log\'!A1:G50".');
  return value;
}
function quoteTab(title: string) { return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${title.replaceAll("'", "''")}'`; }

async function sheetsCall(path: string, init: Parameters<typeof googleFetch>[1] = {}) {
  const response = await googleFetch(`${API}/${spreadsheetId()}${path}`, init);
  if (!response.ok) {
    const status = response.status;
    const hint = status === 403 ? ' The Google account behind the refresh token needs edit access to this spreadsheet, and the token needs the spreadsheets scope.'
      : status === 404 ? ' Check GOOGLE_SHEETS_SPREADSHEET_ID and the tab name.' : '';
    throw new SafeError(`Google Sheets API failed (${status}).${hint}`);
  }
  return response.json();
}

export async function sheetTabs(): Promise<{ title: string; rows: number; columns: number }[]> {
  const data = await sheetsCall('?fields=sheets.properties(title,gridProperties)');
  return (data.sheets || []).map((s: any) => ({ title: s.properties?.title ?? '',
    rows: s.properties?.gridProperties?.rowCount ?? 0, columns: s.properties?.gridProperties?.columnCount ?? 0 }));
}

/** Formatted values, so "$1,200.50" reaches the parser exactly as the CSV export had it. */
export async function readRange(range: string): Promise<string[][]> {
  const data = await sheetsCall(`/values/${encodeURIComponent(validateRange(range))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
  const values = (data.values || []) as unknown[][];
  const cells = values.reduce((n, r) => n + r.length, 0);
  if (cells > MAX_SHEET_CELLS) throw new SafeError(`Range returned ${cells} cells; request at most ${MAX_SHEET_CELLS} at a time.`);
  return values.map(r => r.map(c => (c == null ? '' : String(c))));
}

export async function appendRows(range: string, rows: (string | number)[][]) {
  return sheetsCall(`/values/${encodeURIComponent(validateRange(range))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: { values: rows } });
}
export async function updateRange(range: string, rows: (string | number)[][]) {
  return sheetsCall(`/values/${encodeURIComponent(validateRange(range))}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: { values: rows } });
}
export async function ensureTab(title: string) {
  if ((await sheetTabs()).some(t => t.title === title)) return false;
  await sheetsCall(':batchUpdate', { method: 'POST', body: { requests: [{ addSheet: { properties: { title } } }] } });
  return true;
}

/** The master account list, read live from the Sheet on every call. */
export async function loadSheetAccounts() {
  const rows = await readRange(accountsTab());
  return { version: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    ...parseAccountRows(rows), fetched_at: new Date().toISOString(), source: 'sheet' as const,
    tab: accountsTab() };
}

export const AUDIT_HEADER = ['Timestamp (UTC)', 'User', 'Tool', 'Customer ID', 'Summary', 'Detail', 'Result'];

/**
 * The audit trail lives in the Sheet, which is why this service needs no
 * database. A logging failure never masks the outcome of the change itself.
 */
export async function auditLog(entry: {
  user: string; tool: string; customer_id: string; summary: string; detail: unknown; result: string;
}) {
  if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID) return { logged: false, reason: 'No spreadsheet configured.' };
  try {
    await appendRows(`${quoteTab(auditTab())}!A1`, [[new Date().toISOString(), entry.user, entry.tool,
      entry.customer_id, entry.summary.slice(0, 500), JSON.stringify(entry.detail).slice(0, 5000), entry.result.slice(0, 500)]]);
    return { logged: true };
  } catch {
    return { logged: false, reason: `Could not append to the "${auditTab()}" tab. Create it or run the setup check.` };
  }
}
