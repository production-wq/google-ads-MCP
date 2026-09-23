import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { loadBudget } from '../lib/csv';
import { accountReport } from '../lib/google-ads';
import { verifyToken } from '../lib/auth';

test('CSV is reloaded after replacement, without restarting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ads-csv-test-'));
  const prior = process.env.CSV_LOCAL_PATH;
  try {
    process.env.CSV_LOCAL_PATH = join(dir, 'budget.csv');
    const csv = 'Account name,Customer ID,Ad target spend\nTest,1234567890,$100\n';
    await writeFile(process.env.CSV_LOCAL_PATH, csv);
    const a = await loadBudget();
    await writeFile(process.env.CSV_LOCAL_PATH, csv.replace('$100', '$200'));
    const b = await loadBudget();
    assert.notEqual(a.version, b.version);
    assert.equal(b.accounts[0].target_spend, 200);
  } finally {
    if (prior === undefined) delete process.env.CSV_LOCAL_PATH; else process.env.CSV_LOCAL_PATH = prior;
    await rm(dir, { recursive: true });
  }
});

test('Google report uses authenticated read endpoint, micros conversion and weighted ratios', async () => {
  const priorFetch = globalThis.fetch;
  const keys = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_DEVELOPER_TOKEN'];
  const saved = keys.map(k => process.env[k]);
  keys.forEach(k => process.env[k] = 'synthetic-test-value');
  let empty = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'mock-token', expires_in: 3600 });
    assert.match(url, /\/customers\/1234567890\/googleAds:search$/);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer mock-token');
    assert.match(JSON.parse(init!.body as string).query, /2026-08-19/);
    return Response.json({ results: empty ? [] : [{ customer: { currencyCode: 'USD', timeZone: 'America/New_York' },
      metrics: { costMicros: '150000000', impressions: '1000', clicks: '50', conversions: 2.5 } }] });
  };
  try {
    const data = await accountReport('1234567890', '2026-08-19', '2026-09-17');
    assert.equal(data.report?.cost, 150);
    assert.equal(data.report?.ctr, 0.05);
    assert.equal(data.report?.average_cpc, 3);
    assert.equal(data.report?.cost_per_conversion, 60);
    empty = true;
    assert.equal((await accountReport('1234567890', '2026-08-19', '2026-09-17')).report, null);
  } finally {
    globalThis.fetch = priorFetch;
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
});

test('OAuth verifies signatures, audience, expiry and approved subjects', async () => {
  const priorFetch = globalThis.fetch;
  const keys = ['OAUTH_ISSUER', 'OAUTH_JWKS_URL', 'OAUTH_ALLOWED_SUBJECTS', 'MCP_RESOURCE_URL', 'MCP_API_KEYS_JSON'];
  const saved = keys.map(k => process.env[k]);
  const issuer = 'https://issuer.example.test/', audience = 'https://mcp.example.test/api/mcp';
  Object.assign(process.env, { OAUTH_ISSUER: issuer, OAUTH_JWKS_URL: issuer + 'jwks',
    OAUTH_ALLOWED_SUBJECTS: 'approved-user', MCP_RESOURCE_URL: audience, MCP_API_KEYS_JSON: '{}' });
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  globalThis.fetch = async () => Response.json({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] });
  async function token(sub = 'approved-user', aud = audience, exp = Math.floor(Date.now() / 1000) + 60) {
    return new SignJWT({ scope: 'ads:read' }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(issuer).setAudience(aud).setSubject(sub).setExpirationTime(exp).sign(privateKey);
  }
  try {
    const request = new Request(audience);
    assert.equal((await verifyToken(request, await token()))?.scopes[0], 'ads:read');
    assert.equal(await verifyToken(request, await token('unapproved')), undefined);
    assert.equal(await verifyToken(request, await token('approved-user', 'wrong-audience')), undefined);
    assert.equal(await verifyToken(request, await token('approved-user', audience, 1)), undefined);
    assert.equal(await verifyToken(request, (await token()).slice(0, -5) + 'xxxxx'), undefined);
  } finally {
    globalThis.fetch = priorFetch;
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
});
