// Probe the standard legacy MCP handshake supported by most hosted clients.
import assert from 'node:assert/strict';
const endpoint = process.env.MCP_TEST_URL || 'http://localhost:3000/api/mcp';
const keys = JSON.parse(process.env.MCP_API_KEYS_JSON || '{}') as Record<string, string | { key?: string }>;
const token = process.env.MCP_TEST_TOKEN
  || Object.values(keys).map(v => (typeof v === 'string' ? v : v?.key)).find(Boolean);
if (!token) throw new Error('Set MCP_TEST_TOKEN (a token from /login) or MCP_API_KEYS_JSON in .env.local.');

async function call(method: string, params: object, authorized = true) {
  return fetch(endpoint, { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-03-26', ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
async function json(response: Response) {
  assert.equal(response.status, 200);
  const text = await response.text();
  return JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(l => l.startsWith('data:'))!.slice(5) : text);
}
const payloadOf = (call: { result: { content: { text: string }[] } }) => JSON.parse(call.result.content[0].text);

const READS = ['google_ads_field_metadata', 'google_ads_list_entities', 'google_ads_search',
  'whoami', 'worksheet_account_report', 'worksheet_accounts', 'worksheet_list_tabs', 'worksheet_read_range'];
const WRITES = ['google_ads_add_keywords', 'google_ads_add_negative_keywords', 'google_ads_create_ad_group',
  'google_ads_create_campaign', 'google_ads_remove_keywords', 'google_ads_set_campaign_budget',
  'google_ads_set_keyword_bids', 'google_ads_set_status', 'google_ads_update_ad_copy',
  'worksheet_append_rows', 'worksheet_write_range'];

assert.equal((await call('tools/list', {}, false)).status, 401);
await json(await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }));

const tools = (await json(await call('tools/list', {}))).result.tools as
  { name: string; description: string; annotations?: { readOnlyHint?: boolean } }[];
assert.deepEqual(tools.map(t => t.name).sort(), [...READS, ...WRITES].sort());
for (const tool of tools) {
  const shouldRead = READS.includes(tool.name);
  assert.equal(!!tool.annotations?.readOnlyHint, shouldRead, `${tool.name} has the wrong readOnlyHint`);
  // Appending rows cannot overwrite anything, so it is the one write without a confirmation step.
  if (!shouldRead && tool.name !== 'worksheet_append_rows') {
    assert.match(tool.description, /confirm_token/, `${tool.name} does not document its confirmation step`);
  }
}

const me = payloadOf(await json(await call('tools/call', { name: 'whoami', arguments: {} })));
const accounts = await json(await call('tools/call', { name: 'worksheet_accounts', arguments: { limit: 1 } }));
assert.ok(!accounts.result.isError, JSON.stringify(accounts.result));
const payload = payloadOf(accounts);
assert.ok(payload.total > 0 && payload.csv_version.length === 64);

if (!me.can_write) {
  const refused = payloadOf(await json(await call('tools/call', {
    name: 'google_ads_set_campaign_budget', arguments: { customer_id: '1234567890', campaign_id: '1', new_daily_budget: 1 } })));
  assert.match(refused.error, /read-only|scope/i, 'a read-only token must not reach a write tool');
}

console.log(`PASS: anonymous requests rejected; handshake, ${READS.length} read and ${WRITES.length} write tools discovered with correct annotations;`
  + ` worksheet source "${payload.source}" returned ${payload.total} account(s); signed in as ${me.user} (can_write: ${me.can_write}).`);
