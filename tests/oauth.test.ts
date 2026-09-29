import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, verifyToken, SCOPES } from '../lib/auth';
import { POST as register } from '../app/oauth/register/route';
import { GET as authorizeGet, POST as authorizePost } from '../app/oauth/authorize/route';
import { POST as token } from '../app/oauth/token/route';
import { GET as asMetadata } from '../app/.well-known/oauth-authorization-server/route';

const ORIGIN = 'https://mcp.example.test';
const REDIRECT = 'http://localhost:33418/callback';
const PASSWORD = 'a-long-enough-password';

async function withEnv(run: () => Promise<void>) {
  const keys = ['SESSION_SECRET', 'MCP_USERS_JSON', 'MCP_RESOURCE_URL', 'MCP_API_KEYS_JSON', 'OAUTH_ISSUER'];
  const saved = keys.map(k => process.env[k]);
  const hash = await hashPassword(PASSWORD);
  Object.assign(process.env, {
    SESSION_SECRET: 'o'.repeat(32), MCP_API_KEYS_JSON: '{}',
    MCP_RESOURCE_URL: `${ORIGIN}/api/mcp`,
    MCP_USERS_JSON: JSON.stringify({
      writer: { password_hash: hash, role: 'write' },
      reader: { password_hash: hash, role: 'read' },
    }),
  });
  delete process.env.OAUTH_ISSUER;
  try { await run(); } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
}
const pkce = () => {
  const verifier = randomBytes(40).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const json = (r: Response) => r.json();

async function newClient() {
  const r = await register(new Request(`${ORIGIN}/oauth/register`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }) }));
  assert.equal(r.status, 201);
  return (await json(r)).client_id as string;
}
function authorizeUrl(client_id: string, challenge: string, extra: Record<string, string> = {}) {
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  Object.entries({ client_id, redirect_uri: REDIRECT, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...extra })
    .forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}
async function signIn(client_id: string, challenge: string, username: string, extra: Record<string, string> = {}) {
  const body = new URLSearchParams({ client_id, redirect_uri: REDIRECT, state: 'xyz',
    code_challenge: challenge, username, password: PASSWORD, ...extra });
  return authorizePost(new Request(authorizeUrl(client_id, challenge, extra), { method: 'POST', body }));
}

test('the authorization server advertises what MCP clients need', async () => {
  await withEnv(async () => {
    const meta = await json(asMetadata(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`)));
    assert.equal(meta.issuer, ORIGIN);
    assert.equal(meta.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
    assert.equal(meta.registration_endpoint, `${ORIGIN}/oauth/register`);
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(meta.grant_types_supported, ['authorization_code', 'refresh_token']);
  });
});

test('a client registers, a user signs in, and the code exchanges for a usable token', async () => {
  await withEnv(async () => {
    const client_id = await newClient();
    const { verifier, challenge } = pkce();

    const formPage = await authorizeGet(new Request(authorizeUrl(client_id, challenge)));
    assert.equal(formPage.status, 200);
    const html = await formPage.text();
    assert.match(html, /name="username"/);
    assert.match(html, /Claude/);

    const redirected = await signIn(client_id, challenge, 'writer');
    assert.equal(redirected.status, 302);
    const location = new URL(redirected.headers.get('location')!);
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(location.searchParams.get('state'), 'xyz');
    const code = location.searchParams.get('code')!;
    assert.ok(code);

    const granted = await json(await token(new Request(`${ORIGIN}/oauth/token`, { method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: REDIRECT, client_id }) })));
    assert.equal(granted.token_type, 'Bearer');
    assert.equal(granted.scope, 'ads:read ads:write');
    assert.ok(granted.refresh_token);

    // The access token is accepted by the MCP endpoint's own verifier.
    const info = await verifyToken(new Request(`${ORIGIN}/api/mcp`), granted.access_token);
    assert.equal(info?.clientId, 'writer');
    assert.deepEqual(info?.scopes, SCOPES.write);

    const refreshed = await json(await token(new Request(`${ORIGIN}/oauth/token`, { method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: granted.refresh_token }) })));
    assert.ok(refreshed.access_token);
    assert.equal((await verifyToken(new Request(`${ORIGIN}/api/mcp`), refreshed.access_token))?.clientId, 'writer');
  });
});

test('a read-only user cannot obtain the write scope', async () => {
  await withEnv(async () => {
    const client_id = await newClient();
    const { verifier, challenge } = pkce();
    const redirected = await signIn(client_id, challenge, 'reader', { scope: 'ads:read ads:write' });
    const code = new URL(redirected.headers.get('location')!).searchParams.get('code')!;
    const granted = await json(await token(new Request(`${ORIGIN}/oauth/token`, { method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier }) })));
    assert.equal(granted.scope, 'ads:read');
    assert.deepEqual((await verifyToken(new Request(`${ORIGIN}/api/mcp`), granted.access_token))?.scopes, SCOPES.read);
  });
});

test('PKCE, redirect address and credentials are all enforced', async () => {
  await withEnv(async () => {
    const client_id = await newClient();
    const { verifier, challenge } = pkce();

    // An unregistered redirect address is refused before any password is asked for.
    const stranger = await authorizeGet(new Request(authorizeUrl(client_id, challenge)
      .replace(encodeURIComponent(REDIRECT), encodeURIComponent('https://attacker.test/steal'))));
    assert.equal(stranger.status, 400);
    assert.match(await stranger.text(), /not registered/);

    // Plain (non-S256) challenges are rejected.
    const plain = await authorizeGet(new Request(authorizeUrl(client_id, challenge, { code_challenge_method: 'plain' })));
    assert.equal(plain.status, 302);
    assert.match(plain.headers.get('location')!, /error=invalid_request/);

    // A wrong password re-renders the form rather than issuing a code.
    const wrong = await authorizePost(new Request(authorizeUrl(client_id, challenge), { method: 'POST',
      body: new URLSearchParams({ client_id, redirect_uri: REDIRECT, code_challenge: challenge,
        username: 'writer', password: 'not-the-password' }) }));
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /Invalid username or password/);

    // A stolen code is useless without the matching verifier.
    const code = new URL((await signIn(client_id, challenge, 'writer')).headers.get('location')!).searchParams.get('code')!;
    const stolen = await token(new Request(`${ORIGIN}/oauth/token`, { method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier }) }));
    assert.equal(stolen.status, 400);
    assert.equal((await json(stolen)).error, 'invalid_grant');

    // The real verifier still works, proving only the mismatch was rejected.
    assert.ok((await json(await token(new Request(`${ORIGIN}/oauth/token`, { method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier }) })))).access_token);
  });
});

test('a registration cannot smuggle in a non-local http redirect', async () => {
  await withEnv(async () => {
    const r = await register(new Request(`${ORIGIN}/oauth/register`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Bad', redirect_uris: ['http://attacker.test/cb'] }) }));
    assert.equal(r.status, 400);
    assert.match((await json(r)).error_description, /https/);
  });
});
