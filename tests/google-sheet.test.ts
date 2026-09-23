import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetValues, validateSheetRange } from '../lib/google-sheet';
import { loadBudget } from '../lib/csv';

test('Google sheet reads stay within one configured spreadsheet, are bounded, and feed the existing budget tools', async () => {
  const keys = ['GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_SHEETS_BUDGET_RANGE', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN'];
  const saved = keys.map(k => process.env[k]), priorFetch = globalThis.fetch;
  const id = 'a'.repeat(40); let updated = false;
  Object.assign(process.env, { GOOGLE_SHEETS_SPREADSHEET_ID: id, GOOGLE_SHEETS_BUDGET_RANGE: 'Budget!A1:D100', GOOGLE_ADS_CLIENT_ID: 'sheet-test-client', GOOGLE_ADS_CLIENT_SECRET: 'test', GOOGLE_ADS_REFRESH_TOKEN: 'test-refresh' });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'google-server-token', expires_in: 3600 });
    assert.ok(url.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/`));
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer google-server-token');
    return Response.json({ range: 'Budget!A1:D2', values: [['Account name', 'Customer ID', 'Ad target spend', 'Comments'], ['Company', '1234567890', updated ? '$200' : '$100', 'a, b']] });
  };
  try {
    assert.equal((await sheetValues('Budget!A1:D100')).spreadsheet_id, id);
    const first = await loadBudget(); assert.equal(first.accounts[0].target_spend, 100);
    updated = true; const second = await loadBudget(); assert.equal(second.accounts[0].target_spend, 200); assert.notEqual(first.version, second.version);
    for (const range of ['A:Z', 'A1:ZZ10000', 'A10:A1', 'Z1:A10', 'https://other.example', 'A1']) assert.throws(() => validateSheetRange(range));
    assert.equal(validateSheetRange("'Budget 2026'!A1:D100"), "'Budget 2026'!A1:D100");
  } finally { globalThis.fetch = priorFetch; keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); }
});
