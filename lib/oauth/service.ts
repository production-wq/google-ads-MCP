import { ACCESS_TTL, FLOW_TTL, GRANT_TTL, type Config } from './config';
import { equal, hash, random, checkPassword } from './crypto';
import type { Store } from './store';

export class OAuthFailure extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
function fail(message: string, code = 'invalid_request', status = 400): never { throw new OAuthFailure(code, message, status); }
const now = () => Math.floor(Date.now() / 1000);
const cookieName = '__Host-google-ads-oauth';
type Client = { client_id: string; client_name: string; redirect_uris: string[]; token_endpoint_auth_method: string; secretHash?: string };
type Transaction = { clientId: string; redirect: string; state: string; challenge: string; browserHash: string };
type Grant = { clientId: string; expiresAt: number; credentialVersion: string };
type Reference = { grantId: string; clientId: string; resource: string; expiresAt: number; used?: boolean };
type Code = Reference & { challenge: string; redirect: string };
export type Access = { grantId: string; clientId: string; expiresAt: number };

const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
export function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { ...headers, 'Access-Control-Allow-Origin': '*' } }); }
export function options() { return new Response(null, { status: 204, headers: { ...headers,
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization' } }); }
function redirect(url: string, clearCookie = false) {
  return new Response(null, { status: 303, headers: { ...headers, Location: url,
    ...(clearCookie ? { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } : {}) } });
}
function escape(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
function readCookie(request: Request) {
  return request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '';
}
function validRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return !url.hash && !url.username && !url.password && !url.searchParams.has('code') && !url.searchParams.has('state') &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)));
  } catch { return false; }
}
async function textBody(request: Request) {
  if (Number(request.headers.get('content-length')) > 16_384) fail('Request too large.');
  // Read a bounded stream even when Content-Length is absent or inaccurate.
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); fail('Request too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
async function form(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) fail('Use form-encoded parameters.');
  const data = new URLSearchParams(await textBody(request));
  for (const key of data.keys()) if (data.getAll(key).length !== 1) fail('Duplicate parameter.');
  return data;
}

export class OAuthService {
  constructor(readonly config: Config, private store: Store) {}
  private credentialVersion() { return hash(this.config.username + ":" + this.config.passwordHash); }
  private async throttle(bucket: string, max: number, seconds = 3600) {
    if (!await this.store.limit(bucket, max, seconds)) fail('Too many requests. Try again later.', 'temporarily_unavailable', 429);
  }
  metadata() {
    const base = this.config.origin;
    return json({ issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`, revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'], scopes_supported: ['ads:read'],
      authorization_response_iss_parameter_supported: true });
  }
  resourceMetadata() {
    return json({ resource: this.config.resource, authorization_servers: [this.config.origin],
      scopes_supported: ['ads:read'], bearer_methods_supported: ['header'], resource_name: 'Google Ads MCP' });
  }
  private async client(id: string) {
    if (!/^mcp_client_[\w-]{43}$/.test(id)) fail('Unknown client. Register again.', 'invalid_client', 401);
    const client = await this.store.get<Client>(`client:${id}`);
    if (!client) fail('Unknown client. Register again.', 'invalid_client', 401);
    return client!;
  }
  async register(request: Request) {
    await this.throttle('registration', 100);
    if (!request.headers.get('content-type')?.startsWith('application/json')) fail('Use JSON client metadata.');
    let data;
    try { data = JSON.parse(await textBody(request)); } catch { fail('Invalid client metadata.', 'invalid_client_metadata'); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.redirect_uris) || data.redirect_uris.length < 1 ||
      data.redirect_uris.length > 10 || !data.redirect_uris.every(validRedirect)) fail('Register exact HTTPS or loopback redirect URLs.', 'invalid_redirect_uri');
    const method = data.token_endpoint_auth_method || 'client_secret_basic';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) fail('Unsupported authentication method.', 'invalid_client_metadata');
    if (data.grant_types && (!Array.isArray(data.grant_types) || data.grant_types.some((v: unknown) => !['authorization_code', 'refresh_token'].includes(String(v))))) fail('Unsupported grant type.', 'invalid_client_metadata');
    if (data.response_types && (!Array.isArray(data.response_types) || data.response_types.length !== 1 || data.response_types[0] !== 'code')) fail('Only code responses are supported.', 'invalid_client_metadata');
    if (data.scope !== undefined && data.scope !== 'ads:read') fail('Only ads:read is supported.', 'invalid_client_metadata');
    const id = `mcp_client_${random()}`, secret = method === 'none' ? undefined : random();
    const client: Client = { client_id: id, client_name: typeof data.client_name === 'string' ? data.client_name.slice(0, 100) : 'MCP client',
      redirect_uris: data.redirect_uris, token_endpoint_auth_method: method, ...(secret ? { secretHash: hash(secret) } : {}) };
    // Registrations expire after one year; connections expire sooner and can re-register.
    await this.store.set(`client:${id}`, client, 365 * 86400);
    return json({ client_id: id, client_name: client.client_name, redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      scope: 'ads:read', client_id_issued_at: now(), ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) }, 201);
  }
  async authorize(request: Request) {
    await this.throttle('authorization', 1000);
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) if (params.getAll(key).length !== 1) fail('Duplicate parameter.');
    const client = await this.client(params.get('client_id') || '');
    const target = params.get('redirect_uri') || '';
    // Never redirect errors to an unvalidated client-supplied URI.
    if (!client.redirect_uris.includes(target)) fail('Redirect URL is not registered.');
    if (params.get('response_type') !== 'code') fail('Only authorization code is supported.', 'unsupported_response_type');
    if (params.get('resource') !== this.config.resource) fail('The resource must match this MCP URL.', 'invalid_target');
    if ((params.get('scope') || 'ads:read') !== 'ads:read') fail('Only ads:read is supported.', 'invalid_scope');
    const challenge = params.get('code_challenge') || '';
    if (params.get('code_challenge_method') !== 'S256' || !/^[\w-]{43}$/.test(challenge)) fail('S256 PKCE is required.');
    const state = params.get('state') || '';
    if (state.length > 2048) fail('State is too long.');
    const tx = random(), browser = random();
    const transaction: Transaction = { clientId: client.client_id, redirect: target, state, challenge,
      browserHash: hash(browser) };
    await this.store.set(`pending:${tx}`, transaction, FLOW_TTL);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Company Google Ads MCP</title><style>
body{font:16px system-ui,sans-serif;line-height:1.55;background:#f0f5f7;color:#172c40;margin:0;padding:36px 20px}main{max-width:600px;margin:4vh auto;background:white;border:1px solid #d9e4ea;border-radius:16px;padding:32px}h1{font-size:26px;margin-top:0}code{word-break:break-all}label{display:block;font-weight:600}input{display:block;box-sizing:border-box;width:100%;margin-top:8px;padding:12px;border:1px solid #9daeba;border-radius:6px;font:inherit}button{font:inherit;padding:12px 18px;border:0;border-radius:6px;background:#087e83;color:white;cursor:pointer;margin:8px 8px 0 0}button[value=deny]{background:#e8eef2;color:#172c40}
</style></head><body>
<main><h1>Connect to the company Google Ads MCP</h1>
<p><strong>${escape(client.client_name)}</strong> is requesting read-only access to the company's configured Google Ads data and worksheet.</p>
<p>Check that you started this connection in your AI app. The application name is supplied by the connecting client. Your AI app will receive the connection at:</p>
<p><code>${escape(target)}</code></p>
<p>Use the company MCP username and password provided by your administrator. You do not need to sign in to Google. Everyone with this login has access to the same configured data.</p>
<form method="post" action="/oauth/consent"><input type="hidden" name="transaction" value="${tx}">
<p><label>Company username <input name="username" autocomplete="username" maxlength="256" required></label></p>
<p><label>Company password <input name="password" type="password" autocomplete="current-password" maxlength="256" required></label></p>
<button name="decision" value="approve" type="submit">Sign in and connect</button>
<button name="decision" value="deny" type="submit" formnovalidate>Cancel</button></form></main></body></html>`;
    return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Frame-Options': 'DENY',
      'Set-Cookie': `${cookieName}=${browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${FLOW_TTL}` } });
  }
  private async transaction(request: Request, key: string) {
    const tx = await this.store.get<Transaction>(key);
    if (!tx || !equal(tx.browserHash, hash(readCookie(request)))) fail('Login expired or browser session changed. Start the connection again.');
    const consumed = await this.store.take<Transaction>(key);
    if (!consumed) fail('Login was already used. Start again.');
    return consumed!;
  }
  async consent(request: Request) {
    if (request.headers.get('origin') !== this.config.origin) fail('Invalid consent origin.');
    const params = await form(request), id = params.get('transaction') || '';
    if (!/^[\w-]{43}$/.test(id)) fail('Invalid transaction.');
    if (!['approve', 'deny'].includes(params.get('decision') || '')) fail('Choose whether to connect.');
    const pending = await this.store.get<Transaction>(`pending:${id}`);
    if (!pending || !equal(pending.browserHash, hash(readCookie(request)))) fail('Login expired. Start the connection again.');
    if (params.get('decision') === 'deny') {
      const tx = await this.transaction(request, `pending:${id}`);
      return this.clientRedirect(tx, { error: 'access_denied' });
    }
    // Global bound stops registration churn from bypassing password rate limits.
    await this.throttle('password-attempts', 30, 900);
    const correctPassword = await checkPassword(params.get('password') || '', this.config.passwordHash);
    if (!correctPassword || !equal(params.get('username') || '', this.config.username)) {
      fail('Incorrect company username or password. Go back and try again.', 'access_denied', 401);
    }
    const tx = await this.transaction(request, `pending:${id}`);
    const grantId = random(), expiresAt = now() + GRANT_TTL;
    await this.store.set(`grant:${grantId}`, { clientId: tx.clientId, expiresAt, credentialVersion: this.credentialVersion() } satisfies Grant, GRANT_TTL);
    const code = random();
    await this.store.set(`code:${hash(code)}`, { grantId, clientId: tx.clientId, resource: this.config.resource,
      expiresAt, challenge: tx.challenge, redirect: tx.redirect } satisfies Code, 120);
    return this.clientRedirect(tx, { code });
  }
  private clientRedirect(tx: Transaction, values: Record<string, string>) {
    const url = new URL(tx.redirect);
    for (const [key, value] of Object.entries({ ...values, state: tx.state, iss: this.config.origin })) url.searchParams.set(key, value);
    return redirect(url.href, true);
  }
  private async authenticateClient(request: Request, params: URLSearchParams) {
    let id = params.get('client_id') || '', secret = params.get('client_secret') || '', basic = false;
    const authorization = request.headers.get('authorization');
    if (authorization) {
      if (!authorization.startsWith('Basic ') || secret) fail('Invalid client authentication.', 'invalid_client', 401);
      try {
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':'); if (separator < 0) throw new Error();
        const basicId = decodeURIComponent(decoded.slice(0, separator));
        if (id && id !== basicId) throw new Error();
        id = basicId; secret = decodeURIComponent(decoded.slice(separator + 1)); basic = true;
      } catch { fail('Invalid client authentication.', 'invalid_client', 401); }
    }
    const client = await this.client(id);
    if (client.token_endpoint_auth_method === 'none') {
      if (secret || basic) fail('Unexpected client secret.', 'invalid_client', 401);
    } else if (!secret || !client.secretHash || !equal(hash(secret), client.secretHash) ||
      basic !== (client.token_endpoint_auth_method === 'client_secret_basic')) fail('Invalid client secret.', 'invalid_client', 401);
    return client;
  }
  private async grant(id: string): Promise<Grant | null> {
    const grant = await this.store.get<Grant>(`grant:${id}`);
    if (!grant || grant.credentialVersion !== this.credentialVersion()) return null;
    return grant.expiresAt > now() ? grant : null;
  }
  private async issue(reference: Reference) {
    const grant = await this.grant(reference.grantId);
    if (!grant || grant.clientId !== reference.clientId || reference.expiresAt <= now()) fail('Connection expired. Reconnect.', 'invalid_grant');
    const remaining = Math.min(reference.expiresAt, grant!.expiresAt) - now();
    const access = `mcp_at_${random()}`, refresh = `mcp_rt_${random()}`;
    const ttl = Math.min(ACCESS_TTL, remaining);
    await this.store.set(`access:${hash(access)}`, { ...reference, expiresAt: now() + ttl }, ttl);
    await this.store.set(`refresh:${hash(refresh)}`, { ...reference, used: false }, remaining);
    return json({ access_token: access, token_type: 'Bearer', expires_in: ttl, refresh_token: refresh, scope: 'ads:read' });
  }
  async token(request: Request) {
    const params = await form(request);
    const client = await this.authenticateClient(request, params);
    await this.throttle(`token:${client.client_id}`, 600);
    if (params.get('resource') !== this.config.resource) fail('The resource must match this MCP URL.', 'invalid_target');
    if (params.has('scope') && params.get('scope') !== 'ads:read') fail('Only ads:read is supported.', 'invalid_scope');
    if (params.get('grant_type') === 'authorization_code') {
      const key = `code:${hash(params.get('code') || '')}`;
      const code = await this.store.get<Code>(key);
      const verifier = params.get('code_verifier') || '';
      if (!code || code.clientId !== client.client_id || code.resource !== this.config.resource ||
        code.redirect !== params.get('redirect_uri') || !/^[\w.~-]{43,128}$/.test(verifier) || !equal(hash(verifier), code.challenge)) fail('Invalid or expired authorization code.', 'invalid_grant');
      const consumed = await this.store.take<Code>(key);
      if (!consumed) fail('Authorization code already used.', 'invalid_grant');
      return this.issue(consumed!);
    }
    if (params.get('grant_type') === 'refresh_token') {
      const key = `refresh:${hash(params.get('refresh_token') || '')}`;
      const reference = await this.store.get<Reference>(key);
      if (!reference || reference.clientId !== client.client_id || reference.resource !== this.config.resource) fail('Invalid refresh token.', 'invalid_grant');
      const consumed = await this.store.consumeRefresh<Reference>(key);
      if (!consumed) fail('Invalid refresh token.', 'invalid_grant');
      if (consumed!.reused) {
        await this.store.del(`grant:${reference!.grantId}`);
        fail('Refresh token reused. Sign in again.', 'invalid_grant');
      }
      return this.issue(consumed!.value);
    }
    fail('Unsupported grant type.', 'unsupported_grant_type');
  }
  async verifyAccess(token: string): Promise<Access | null> {
    if (!/^mcp_at_[\w-]{43}$/.test(token)) return null;
    const reference = await this.store.get<Reference>(`access:${hash(token)}`);
    if (!reference || reference.resource !== this.config.resource || reference.expiresAt <= now()) return null;
    const grant = await this.grant(reference.grantId);
    if (!grant || grant.clientId !== reference.clientId) return null;
    return { grantId: reference.grantId, clientId: reference.clientId, expiresAt: reference.expiresAt };
  }
  async revoke(request: Request) {
    const params = await form(request), client = await this.authenticateClient(request, params);
    await this.throttle(`revoke:${client.client_id}`, 120);
    const token = params.get('token') || '';
    const key = `${token.startsWith('mcp_rt_') ? 'refresh' : 'access'}:${hash(token)}`;
    const reference = await this.store.get<Reference>(key);
    if (reference?.clientId === client.client_id) await this.store.del(`grant:${reference.grantId}`);
    return json({}); // RFC 7009 does not disclose whether another client's token exists.
  }
}
