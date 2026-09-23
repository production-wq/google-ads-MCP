// Probe the standard legacy MCP handshake supported by most hosted clients.
import assert from 'node:assert/strict';
const endpoint = process.env.MCP_TEST_URL || 'http://localhost:3000/api/mcp';
const keys = JSON.parse(process.env.MCP_API_KEYS_JSON || '{}') as Record<string, string>;
const token = process.env.MCP_TEST_TOKEN || Object.values(keys)[0];
if (!token) throw new Error('Set MCP_TEST_TOKEN or MCP_API_KEYS_JSON in .env.local.');
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
assert.equal((await call('tools/list', {}, false)).status, 401);
await json(await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }));
const tools = await json(await call('tools/list', {}));
assert.deepEqual(tools.result.tools.map((t: {name: string}) => t.name).sort(),
  ['google_ads_field_metadata', 'google_ads_search', 'worksheet_account_report', 'worksheet_accounts']);
assert.ok(tools.result.tools.every((t: {annotations?: {readOnlyHint?: boolean}}) => t.annotations?.readOnlyHint));
const budget = await json(await call('tools/call', { name: 'worksheet_accounts', arguments: { limit: 1 } }));
assert.ok(!budget.result.isError);
const payload = JSON.parse(budget.result.content[0].text);
assert.ok(payload.total > 0 && payload.csv_version.length === 64);
console.log('PASS: anonymous requests rejected; MCP handshake, read-only tool discovery, and CSV tool call.');
