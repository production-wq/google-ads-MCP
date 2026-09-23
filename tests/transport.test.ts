import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST, OPTIONS } from '../app/api/mcp/route';

test('HTTP MCP authentication, CORS, initialization and real tool dispatch', async () => {
  const keys = ['MCP_API_KEYS_JSON', 'MCP_ALLOWED_ORIGINS', 'CSV_LOCAL_PATH', 'VERCEL'];
  const saved = keys.map(k => process.env[k]);
  const dir = await mkdtemp(join(tmpdir(), 'mcp-transport-'));
  const token = 'synthetic-test-key-'.repeat(4);
  const origin = 'https://client.example.test';
  Object.assign(process.env, {
    MCP_API_KEYS_JSON: JSON.stringify({ test: token }),
    MCP_ALLOWED_ORIGINS: `https://other.example.test, ${origin} `,
    CSV_LOCAL_PATH: join(dir, 'budget.csv'),
  });
  delete process.env.VERCEL;
  await writeFile(process.env.CSV_LOCAL_PATH!, 'Account name,Customer ID,Ad target spend\nExample,1234567890,100\n');
  async function call(method: string, params: object, bearer: string | null = token, browserOrigin: string | null = origin) {
    return POST(new Request('http://localhost:3000/api/mcp', {
      method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-03-26',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(browserOrigin ? { Origin: browserOrigin } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
  }
  async function payload(response: Response) {
    assert.equal(response.status, 200);
    const body = await response.text();
    const data = body.split('\n').find(line => line.startsWith('data:'));
    const value = JSON.parse(data ? data.slice(5) : body);
    assert.equal(value.error, undefined);
    return value.result;
  }
  try {
    const preflight = OPTIONS(new Request('http://localhost:3000/api/mcp', { method: 'OPTIONS', headers: { Origin: origin } }));
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('Access-Control-Allow-Headers')!, /Mcp-Session-Id/i);
    const anonymous = await call('tools/list', {}, null);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('Access-Control-Allow-Origin'), origin);
    assert.match(anonymous.headers.get('Access-Control-Expose-Headers')!, /WWW-Authenticate/i);
    assert.match(anonymous.headers.get('WWW-Authenticate')!, /oauth-protected-resource/);
    assert.match(anonymous.headers.get('Vary')!, /Origin/);
    assert.equal((await call('tools/list', {}, 'invalid')).status, 401);
    assert.equal((await call('tools/list', {}, token, 'https://unapproved.example.test')).status, 403);
    const init = await payload(await call('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    }));
    assert.equal(init.serverInfo.name, 'google-ads-worksheet');
    const discovered = await payload(await call('tools/list', {}, token, null));
    assert.equal(discovered.tools.length, 4);
    assert.ok(discovered.tools.every((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint));
    const accounts = await payload(await call('tools/call', { name: 'worksheet_accounts', arguments: { limit: 1 } }));
    assert.ok(!accounts.isError);
    const data = JSON.parse(accounts.content[0].text);
    assert.equal(data.accounts[0].customer_id, '1234567890');
    assert.equal(data.csv_version.length, 64);
    const denied = await payload(await call('tools/call', {
      name: 'google_ads_search', arguments: { customer_id: '9999999999', query: 'SELECT customer.id FROM customer LIMIT 1' },
    }));
    assert.equal(denied.isError, true);
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    await rm(dir, { recursive: true });
  }
});
