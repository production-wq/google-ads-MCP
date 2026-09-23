import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthService, OAuthFailure } from '../lib/oauth/service';
import { hash, random, hashPassword } from '../lib/oauth/crypto';
import type { Config } from '../lib/oauth/config';
import type { Store } from '../lib/oauth/store';
import { sharedLoginMode, oauthConfig } from '../lib/oauth/config';
import { POST } from '../app/api/mcp/route';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No in-memory fallback exists in production. This adapter is solely for tests.
class MemoryStore implements Store {
  values = new Map<string, { value: unknown; until: number }>();
  counts = new Map<string, number>();
  async get<T>(key: string): Promise<T | null> {
    const row = this.values.get(key);
    return !row || row.until <= Date.now() ? null : structuredClone(row.value) as T;
  }
  async set(key: string, value: unknown, seconds: number) { this.values.set(key, { value: structuredClone(value), until: Date.now() + seconds * 1000 }); }
  async del(key: string) { this.values.delete(key); }
  async take<T>(key: string): Promise<T | null> {
    const row = this.values.get(key); this.values.delete(key);
    return !row || row.until <= Date.now() ? null : structuredClone(row.value) as T;
  }
  async consumeRefresh<T>(key: string) {
    const row = this.values.get(key); if (!row || row.until <= Date.now()) return null;
    const value = row.value as { used?: boolean }; const reused = !!value.used; value.used = true;
    return { value: structuredClone(value) as T, reused };
  }
  async limit(key: string, max: number) { const n = (this.counts.get(key) || 0) + 1; this.counts.set(key, n); return n <= max; }
}
const password = 'synthetic company password only';
const config: Config = { resource: 'https://ads.example.test/api/mcp', origin: 'https://ads.example.test', username: 'company', passwordHash: await hashPassword(password) };
function setup() { const store = new MemoryStore(); return { store, service: new OAuthService(config, store) }; }
const post = (path: string, fields: Record<string, string>, extra: Record<string, string> = {}) => new Request(config.origin + path, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams(fields),
});
async function register(service: OAuthService, metadata: Record<string, unknown> = {}) {
  return (await service.register(new Request(config.origin + '/oauth/register', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test AI', redirect_uris: ['https://ai.example.test/callback'], token_endpoint_auth_method: 'none', ...metadata }) }))).json();
}
async function begin(service: OAuthService, client: { client_id: string }) {
  const verifier = random();
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://ai.example.test/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: hash(verifier), resource: config.resource, scope: 'ads:read', state: 'client-state' });
  const response = await service.authorize(new Request(config.origin + '/oauth/authorize?' + params));
  const html = await response.text(), cookie = response.headers.get('set-cookie')!.split(';')[0];
  const transaction = /name="transaction" value="([^"]+)"/.exec(html)![1];
  return { cookie, transaction, verifier, html, response, params };
}
async function login(service: OAuthService, client: { client_id: string }) {
  const flow = await begin(service, client);
  const response = await service.consent(post('/oauth/consent', { transaction: flow.transaction, decision: 'approve', username: config.username, password }, { Cookie: flow.cookie, Origin: config.origin }));
  const callback = new URL(response.headers.get('location')!);
  assert.equal(callback.origin, 'https://ai.example.test'); assert.equal(callback.searchParams.get('state'), 'client-state');
  const code = callback.searchParams.get('code')!;
  return { ...flow, code, fields: { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: 'https://ai.example.test/callback', code, code_verifier: flow.verifier, resource: config.resource } };
}
async function connect(service: OAuthService, client: { client_id: string }) {
  const flow = await login(service, client);
  return { ...flow, tokens: await (await service.token(post('/oauth/token', flow.fields))).json() };
}
const failure = (code: string) => (error: unknown) => error instanceof OAuthFailure && error.code === code;

test('Company password login creates distinct connections without storing password or raw bearer tokens', async () => {
  const { service, store } = setup(); const client = await register(service);
  const a = await connect(service, client), b = await connect(service, client);
  const av = (await service.verifyAccess(a.tokens.access_token))!, bv = (await service.verifyAccess(b.tokens.access_token))!;
  assert.notEqual(av.grantId, bv.grantId); assert.equal(av.clientId, bv.clientId);
  assert.ok(!JSON.stringify([...store.values.values()]).includes(password));
  assert.ok(!JSON.stringify([...store.values.values()]).includes(a.tokens.access_token));
  assert.equal(await service.verifyAccess(password), null);
  assert.equal(await service.verifyAccess('old-api-key'), null);
});

test('Login requires correct password, CSRF cookie, exact origin and explicit consent', async () => {
  const { service, store } = setup(); const client = await register(service, { client_name: '<script>bad</script>' });
  const flow = await begin(service, client);
  assert.ok(flow.html.includes('&lt;script&gt;')); assert.ok(!flow.html.includes('<script>'));
  assert.match(flow.response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.match(flow.response.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Lax/);
  const fields = { transaction: flow.transaction, decision: 'approve', username: config.username, password };
  await assert.rejects(service.consent(post('/oauth/consent', fields, { Origin: config.origin })), failure('invalid_request'));
  await assert.rejects(service.consent(post('/oauth/consent', fields, { Origin: 'https://evil.example', Cookie: flow.cookie })), failure('invalid_request'));
  await assert.rejects(service.consent(post('/oauth/consent', { ...fields, password: 'wrong' }, { Origin: config.origin, Cookie: flow.cookie })), failure('access_denied'));
  assert.equal([...store.values.keys()].filter(k => k.startsWith('grant:')).length, 0);
  const canceled = await service.consent(post('/oauth/consent', { transaction: flow.transaction, decision: 'deny' }, { Origin: config.origin, Cookie: flow.cookie }));
  assert.equal(new URL(canceled.headers.get('location')!).searchParams.get('error'), 'access_denied');
  await assert.rejects(service.consent(post('/oauth/consent', fields, { Origin: config.origin, Cookie: flow.cookie })), failure('invalid_request'));
  store.counts.set('password-attempts', 30);
  const another = await begin(service, client);
  await assert.rejects(service.consent(post('/oauth/consent', { ...fields, transaction: another.transaction }, { Origin: config.origin, Cookie: another.cookie })), failure('temporarily_unavailable'));
});

test('Authorization enforces registered redirect, target resource, scope and PKCE', async () => {
  const { service } = setup(); const client = await register(service); const flow = await begin(service, client);
  for (const [key, value] of [['redirect_uri', 'https://evil.example/callback'], ['resource', 'https://other.example/mcp'], ['scope', 'ads:write'], ['code_challenge_method', 'plain']]) {
    const params = new URLSearchParams(flow.params); params.set(key, value);
    await assert.rejects(service.authorize(new Request(config.origin + '/oauth/authorize?' + params)));
  }
});

test('Codes bind client, redirect, verifier and resource; concurrent redemption succeeds only once', async () => {
  const { service } = setup(); const client = await register(service), other = await register(service);
  const flow = await login(service, client);
  for (const overrides of [{ client_id: other.client_id }, { redirect_uri: 'https://evil.example/callback' }, { code_verifier: random() }]) {
    await assert.rejects(service.token(post('/oauth/token', { ...flow.fields, ...overrides })), failure('invalid_grant'));
  }
  await assert.rejects(service.token(post('/oauth/token', { ...flow.fields, resource: 'https://other.example/mcp' })), failure('invalid_target'));
  const raced = await Promise.allSettled([service.token(post('/oauth/token', flow.fields)), service.token(post('/oauth/token', flow.fields))]);
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
});

test('Refresh rotation, replay detection, client-bound revocation and password rotation', async () => {
  const { service, store } = setup(); const client = await register(service), other = await register(service);
  const a = await connect(service, client), b = await connect(service, client);
  const fields = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: a.tokens.refresh_token, resource: config.resource };
  await assert.rejects(service.token(post('/oauth/token', { ...fields, client_id: other.client_id })), failure('invalid_grant'));
  const rotated = await (await service.token(post('/oauth/token', fields))).json();
  assert.notEqual(rotated.refresh_token, a.tokens.refresh_token);
  await assert.rejects(service.token(post('/oauth/token', fields)), failure('invalid_grant'));
  assert.equal(await service.verifyAccess(rotated.access_token), null);
  assert.ok(await service.verifyAccess(b.tokens.access_token));
  await service.revoke(post('/oauth/revoke', { client_id: other.client_id, token: b.tokens.access_token }));
  assert.ok(await service.verifyAccess(b.tokens.access_token));
  const changed = new OAuthService({ ...config, passwordHash: await hashPassword('a different strong test password') }, store);
  assert.equal(await changed.verifyAccess(b.tokens.access_token), null);
  await assert.rejects(changed.token(post('/oauth/token', { ...fields, refresh_token: b.tokens.refresh_token })), failure('invalid_grant'));
  await service.revoke(post('/oauth/revoke', { client_id: client.client_id, token: b.tokens.refresh_token }));
  assert.equal(await service.verifyAccess(b.tokens.access_token), null);
});

test('Registration validates redirects and authenticates confidential clients', async () => {
  const { service } = setup();
  for (const url of ['javascript:alert(1)', 'http://public.example/callback', 'https://example.test/cb#fragment', 'https://user:pass@example.test/cb']) await assert.rejects(register(service, { redirect_uris: [url] }), failure('invalid_redirect_uri'));
  assert.ok((await register(service, { redirect_uris: ['http://127.0.0.1:9876/callback'] })).client_id);
  for (const method of ['client_secret_post', 'client_secret_basic']) {
    const client = await register(service, { token_endpoint_auth_method: method }); const flow = await login(service, client);
    await assert.rejects(service.token(post('/oauth/token', flow.fields)), failure('invalid_client'));
    const request = method === 'client_secret_post' ? post('/oauth/token', { ...flow.fields, client_secret: client.client_secret })
      : post('/oauth/token', flow.fields, { Authorization: 'Basic ' + Buffer.from(client.client_id + ':' + client.client_secret).toString('base64') });
    assert.equal((await service.token(request)).status, 200);
  }
});

test('Expired authorization codes and access tokens fail closed', async () => {
  const { service, store } = setup(); const client = await register(service); const flow = await login(service, client);
  store.values.get(`code:${hash(flow.code)}`)!.until = 0;
  await assert.rejects(service.token(post('/oauth/token', flow.fields)), failure('invalid_grant'));
  const a = await connect(service, client);
  store.values.get(`access:${hash(a.tokens.access_token)}`)!.until = 0;
  assert.equal(await service.verifyAccess(a.tokens.access_token), null);
});

test('Real MCP route accepts company OAuth tokens, shares the worksheet, rejects old keys and unknown accounts', async () => {
  const { service, store } = setup(); const client = await register(service); const a = await connect(service, client), b = await connect(service, client);
  const keys = ['MCP_AUTH_MODE', 'MCP_RESOURCE_URL', 'MCP_LOGIN_USERNAME', 'MCP_LOGIN_PASSWORD_HASH', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'CSV_LOCAL_PATH', 'VERCEL', 'MCP_API_KEYS_JSON', 'GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_ADS_ALLOWED_CUSTOMER_IDS'];
  const saved = keys.map(k => process.env[k]); const priorFetch = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'company-login-'));
  Object.assign(process.env, { MCP_AUTH_MODE: 'shared-login', MCP_RESOURCE_URL: config.resource, MCP_LOGIN_USERNAME: config.username, MCP_LOGIN_PASSWORD_HASH: config.passwordHash, UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test', CSV_LOCAL_PATH: join(dir, 'budget.csv'), MCP_API_KEYS_JSON: JSON.stringify({ old: 'a'.repeat(64) }), GOOGLE_ADS_ALLOWED_CUSTOMER_IDS: '1234567890' });
  delete process.env.VERCEL; delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  await writeFile(process.env.CSV_LOCAL_PATH!, 'Account name,Customer ID,Ad target spend\nCompany,1234567890,100\n');
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://redis.example.test/');
    const [command, key] = JSON.parse(init!.body as string); assert.equal(command, 'GET');
    const value = await store.get(key.replace('google-ads-oauth:v1:', ''));
    return Response.json({ result: value === null ? null : JSON.stringify(value) });
  };
  async function call(token: string, method: string, params: object) {
    return POST(new Request(config.resource, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
  }
  async function result(response: Response) {
    assert.equal(response.status, 200); const text = await response.text(); const data = text.split('\n').find(l => l.startsWith('data:'));
    const value = JSON.parse(data ? data.slice(5) : text); assert.equal(value.error, undefined); return value.result;
  }
  try {
    assert.equal((await call('a'.repeat(64), 'tools/list', {})).status, 401);
    const [ar, br] = await Promise.all([call(a.tokens.access_token, 'tools/call', { name: 'worksheet_accounts', arguments: {} }), call(b.tokens.access_token, 'tools/call', { name: 'worksheet_accounts', arguments: {} })]);
    assert.deepEqual(JSON.parse((await result(ar)).content[0].text).accounts, JSON.parse((await result(br)).content[0].text).accounts);
    const denied = await result(await call(a.tokens.access_token, 'tools/call', { name: 'google_ads_search', arguments: { customer_id: '9999999999', query: 'SELECT customer.id FROM customer LIMIT 1' } }));
    assert.equal(denied.isError, true);
    await service.revoke(post('/oauth/revoke', { client_id: client.client_id, token: a.tokens.access_token }));
    assert.equal((await call(a.tokens.access_token, 'tools/list', {})).status, 401);
  } finally {
    globalThis.fetch = priorFetch;
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    await rm(dir, { recursive: true });
  }
});

test('Configuration rejects typo mode and plaintext password configuration', () => {
  const keys = ['MCP_AUTH_MODE', 'MCP_RESOURCE_URL', 'MCP_LOGIN_USERNAME', 'MCP_LOGIN_PASSWORD_HASH']; const saved = keys.map(k => process.env[k]);
  try {
    process.env.MCP_AUTH_MODE = 'typo'; assert.throws(sharedLoginMode);
    Object.assign(process.env, { MCP_RESOURCE_URL: config.resource, MCP_LOGIN_USERNAME: 'company', MCP_LOGIN_PASSWORD_HASH: 'plaintext' }); assert.throws(oauthConfig);
  } finally { keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); }
});
