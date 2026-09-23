import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBudget, assertVersion, authorizedAccount } from '../lib/csv';
import { validateDates, validateQuery } from '../lib/google-ads';
import { verifyToken } from '../lib/auth';

const csv = '\ufeff,,,,,Key,Green\nAccount name,Customer ID,Ad target spend,Comments\n"Sample, Inc.",123-456-7890,"$1,200.50","first\nsecond"\nPaused,234-567-8901,Canceled/Paused,\nZero,345-678-9012,$0,\nUnknown,456-789-0123,????,\n';
test('real template preamble, multiline notes, numeric zero, missing budgets and revision changes', () => {
  const data = parseBudget(csv);
  assert.equal(data.accounts.length, 4);
  assert.equal(data.accounts[0].target_spend, 1200.50);
  assert.equal(data.accounts[0].comments, 'first\nsecond');
  assert.equal(data.accounts[1].target_spend, null);
  assert.equal(data.accounts[2].target_spend, 0);
  assert.equal(data.accounts[3].target_spend, null);
  assert.notEqual(data.version, parseBudget(csv.replace('$0', '$10')).version);
  assert.throws(() => assertVersion(data.version, 'old'));
});
test('invalid replacement and duplicate IDs rejected', () => {
  assert.throws(() => parseBudget('wrong,header\nx,y'));
  assert.throws(() => parseBudget(csv + 'Duplicate,1234567890,$5,\n'));
});
test('Google account must be in CSV and deployment allowlist', () => {
  const prior = process.env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS;
  try {
    process.env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS = '1234567890,9999999999';
    const rows = parseBudget(csv).accounts;
    assert.equal(authorizedAccount(rows, '123-456-7890').customer_id, '1234567890');
    assert.throws(() => authorizedAccount(rows, '2345678901'));
    assert.throws(() => authorizedAccount(rows, '9999999999'));
  } finally { if (prior === undefined) delete process.env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS; else process.env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS = prior; }
});
test('query bounds, read-only query and calendar validation', () => {
  assert.equal(validateQuery('SELECT campaign.id FROM campaign LIMIT 10'), 'SELECT campaign.id FROM campaign LIMIT 10');
  for (const q of ['DELETE FROM campaign LIMIT 1', 'SELECT campaign.id FROM campaign', 'SELECT campaign.id FROM campaign LIMIT 501', 'SELECT campaign.id FROM campaign LIMIT 1;']) assert.throws(() => validateQuery(q));
  validateDates('2026-08-19', '2026-09-17');
  assert.throws(() => validateDates('2026-02-30', '2026-03-01'));
  assert.throws(() => validateDates('2026-09-17', '2026-08-19'));
});
test('API auth fails closed, separate keys resolve separate identities', async () => {
  const prior = process.env.MCP_API_KEYS_JSON;
  try {
    process.env.MCP_API_KEYS_JSON = JSON.stringify({ claude: 'a'.repeat(32), other: 'b'.repeat(32) });
    const req = new Request('http://localhost/api/mcp');
    assert.equal(await verifyToken(req), undefined);
    assert.equal(await verifyToken(req, 'wrong'), undefined);
    assert.equal((await verifyToken(req, 'a'.repeat(32)))?.clientId, 'claude');
    assert.equal((await verifyToken(req, 'b'.repeat(32)))?.clientId, 'other');
  } finally { if (prior === undefined) delete process.env.MCP_API_KEYS_JSON; else process.env.MCP_API_KEYS_JSON = prior; }
});
