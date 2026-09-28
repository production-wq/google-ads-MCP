import { accessToken, GOOGLE_SCOPES } from '../lib/google-auth';
import { adsRequest, searchRows } from '../lib/google-ads';
import { AUDIT_HEADER, accountsTab, auditTab, appendRows, ensureTab, loadSheetAccounts, readRange, sheetTabs } from '../lib/sheets';
import { customerId } from '../lib/csv';
import { loadUsers } from '../lib/auth';

/** End-to-end configuration check. Reads and reports; it never changes Google Ads. */
let failures = 0;
const ok = (msg: string) => console.log(`  ok    ${msg}`);
const warn = (msg: string) => console.log(`  warn  ${msg}`);
const bad = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`); };
const section = (name: string) => console.log(`\n${name}`);
const ids = (key: string) => (process.env[key] || '').split(',').map(s => s.trim()).filter(Boolean);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

section('1. Environment');
for (const key of ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_DEVELOPER_TOKEN']) {
  process.env[key] ? ok(`${key} is set`) : bad(`${key} is missing`);
}
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? ok('GOOGLE_ADS_LOGIN_CUSTOMER_ID is set (manager account)') : warn('GOOGLE_ADS_LOGIN_CUSTOMER_ID is not set; required when querying accounts under a manager account');
(process.env.SESSION_SECRET || '').length >= 32 ? ok('SESSION_SECRET is set') : bad('SESSION_SECRET is missing or shorter than 32 characters; logins and confirmations will not work');
process.env.GOOGLE_SHEETS_SPREADSHEET_ID ? ok('GOOGLE_SHEETS_SPREADSHEET_ID is set') : warn('No Sheet configured; the service falls back to the Blob CSV');

section('2. Users');
const users = Object.entries(loadUsers());
if (!users.length) bad('MCP_USERS_JSON has no valid users. Run: npm run user:hash -- <name> <password> write');
for (const [name, user] of users) ok(`${name} (${user.role})`);
if (users.length && !users.some(([, u]) => u.role === 'write')) warn('No user has the write role, so nobody can change anything');

section('3. Google sign-in');
try {
  await accessToken();
  ok('Refresh token exchanged for an access token');
} catch (e) { bad(`Could not get an access token: ${message(e)}`); }

section('4. Google Ads access');
const readIds = ids('GOOGLE_ADS_ALLOWED_CUSTOMER_IDS').map(customerId);
const writeIds = ids('GOOGLE_ADS_WRITE_CUSTOMER_IDS').map(customerId);
if (!readIds.length) bad('GOOGLE_ADS_ALLOWED_CUSTOMER_IDS is empty, so every Ads query is denied');
try {
  const accessible = await adsRequest('customers:listAccessibleCustomers') as { resourceNames?: string[] };
  const direct = (accessible.resourceNames || []).map(r => r.split('/').pop() || '');
  ok(`The credentials reach ${direct.length} account(s) directly`);

  // One query against the manager lists every client account, rather than one call per account.
  const manager = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replaceAll('-', '') || direct[0];
  const clients = await searchRows(manager, `SELECT customer_client.id, customer_client.descriptive_name,
    customer_client.status, customer_client.manager, customer_client.currency_code
    FROM customer_client WHERE customer_client.status != 'CLOSED'`);
  const spendable = new Map(clients.filter(c => !c.customerClient?.manager)
    .map(c => [String(c.customerClient.id), c.customerClient]));
  ok(`Manager ${manager} exposes ${spendable.size} spendable client account(s)`);
  const absent = readIds.filter(id => !spendable.has(id));
  if (absent.length) warn(`In the read allowlist but not under the manager (${absent.length}): ${absent.slice(0, 8).join(', ')}${absent.length > 8 ? ' …' : ''}`);
  else ok('Every allowlisted account sits under the manager');

  for (const id of readIds.filter(id => spendable.has(id)).slice(0, 3)) {
    try {
      const row = (await searchRows(id, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1'))[0]?.customer;
      ok(`live query ${id} → ${row?.descriptiveName ?? 'unnamed'} (${row?.currencyCode}, ${row?.timeZone})`);
    } catch (e) { bad(`live query ${id} → ${message(e)}`); }
  }
} catch (e) {
  const detail = message(e);
  if (/CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION|DEVELOPER_TOKEN_NOT_APPROVED/.test(detail)) {
    bad('Google Ads is restricted to TEST accounts: the developer token / Cloud project is not approved for production.');
    warn('Fix: in the manager account, Tools → Setup → API Center, apply for Basic access, naming the Cloud project that owns your OAuth client. Google typically replies within a few business days.');
    warn('Nothing else here is blocked by this. The Google Sheet half works today.');
  } else bad(`Google Ads unreachable: ${detail}`);
}
if (!writeIds.length) warn('GOOGLE_ADS_WRITE_CUSTOMER_IDS is empty: every write tool refuses. This is the safe default.');
for (const id of writeIds) {
  readIds.includes(id) ? ok(`write ${id} is also readable`) : bad(`write ${id} is not in GOOGLE_ADS_ALLOWED_CUSTOMER_IDS, so writes to it are blocked`);
}
ok(`Guardrails: max daily budget ${process.env.MAX_DAILY_BUDGET || 1000}, max budget change ${process.env.MAX_BUDGET_CHANGE_PERCENT || 50}%`);

section('5. Master Google Sheet');
if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID) warn('Skipped: no spreadsheet configured');
else try {
  const tabs = await sheetTabs();
  ok(`Opened the spreadsheet; ${tabs.length} tab(s): ${tabs.map(t => t.title).join(', ')}`);
  if (!tabs.some(t => t.title === accountsTab())) {
    bad(`No tab named "${accountsTab()}". Set SHEETS_ACCOUNTS_TAB to the tab holding Account name / Customer ID / Ad target spend.`);
  } else {
    const data = await loadSheetAccounts();
    ok(`Parsed ${data.accounts.length} account(s) from "${accountsTab()}"; ${data.accounts.filter(a => a.target_spend !== null).length} have numeric targets`);
    const unlisted = readIds.filter(id => !data.accounts.some(a => a.customer_id === id));
    if (unlisted.length) warn(`Allowlisted but not in the sheet, so unreachable: ${unlisted.join(', ')}`);
  }
  if (await ensureTab(auditTab())) {
    await appendRows(`'${auditTab().replaceAll("'", "''")}'!A1`, [AUDIT_HEADER]);
    ok(`Created the "${auditTab()}" tab with its header row`);
  } else {
    const header = await readRange(`'${auditTab().replaceAll("'", "''")}'!A1:G1`);
    header[0]?.[0] ? ok(`Audit tab "${auditTab()}" is ready`) : warn(`Audit tab "${auditTab()}" exists but has no header row`);
  }
} catch (e) { bad(`Sheet check failed: ${message(e)}`); warn(`The Google account behind the refresh token needs edit access, and the token needs ${GOOGLE_SCOPES[1]}`); }

console.log(failures ? `\n${failures} check(s) failed. Fix those before connecting an AI client.\n` : '\nAll checks passed. The MCP is ready to connect.\n');
process.exit(failures ? 1 : 0);
