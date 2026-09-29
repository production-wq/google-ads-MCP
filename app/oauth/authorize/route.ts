import { authenticateUser } from '../../../lib/auth';
import { errorRedirect, grantedScopes, issueCode, readClient } from '../../../lib/oauth';
import { SafeError } from '../../../lib/errors';

export const dynamic = 'force-dynamic';

type Params = { client_id: string; redirect_uri: string; state: string | null; code_challenge: string; scope: string | null };

/** Slows password guessing per instance. Not a substitute for a strong passphrase. */
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60 * 1000, MAX_FAILURES = 10;

const escape = (s: string) => s.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function page(body: string, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8eaed;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:26rem;padding:32px 20px;box-sizing:border-box}
h1{font-size:1.25rem;margin:0 0 4px}
p.sub{color:#9aa3af;font-size:.88rem;margin:0 0 22px}
label{display:block;margin-top:16px;font-size:.82rem;color:#9aa3af}
input{width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border-radius:8px;
border:1px solid #2c313a;background:#171a20;color:#e8eaed;font-size:15px}
button{width:100%;margin-top:24px;padding:11px 12px;border-radius:8px;border:1px solid #2f6feb;
background:#2f6feb;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{margin-top:16px;color:#ff7b72;font-size:.88rem}
.scopes{margin-top:18px;padding:12px 14px;border:1px solid #2c313a;border-radius:8px;background:#171a20;font-size:.85rem;color:#9aa3af}
code{font-family:ui-monospace,monospace;color:#e8eaed;word-break:break-all}
</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function form(p: Params, clientName: string, error?: string) {
  const hidden = Object.entries({
    client_id: p.client_id, redirect_uri: p.redirect_uri, state: p.state ?? '',
    code_challenge: p.code_challenge, scope: p.scope ?? '',
  }).map(([k, v]) => `<input type="hidden" name="${k}" value="${escape(v)}">`).join('');
  return page(`<h1>Google Ads Worksheet MCP</h1>
<p class="sub">Sign in to let <strong>${escape(clientName)}</strong> use the worksheet and Google Ads on your behalf.</p>
<form method="post">${hidden}
<label>Username<input name="username" autocomplete="username" autocapitalize="none" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
${error ? `<p class="err">${escape(error)}</p>` : ''}
<button type="submit">Sign in</button></form>
<div class="scopes">This grants read access to the master sheet and Google Ads. Changing anything also requires the
write role on your account, and every change is previewed and logged before it applies.</div>`, error ? 401 : 200);
}

/** Validates the request against the signed client_id. Returns either params or a Response to send back. */
async function resolve(url: URL): Promise<{ params: Params; clientName: string } | Response> {
  const client_id = url.searchParams.get('client_id') || '';
  const redirect_uri = url.searchParams.get('redirect_uri') || '';
  if (!client_id || !redirect_uri) return page('<h1>Sign-in failed</h1><p class="sub">The request is missing client_id or redirect_uri.</p>', 400);

  let client: Awaited<ReturnType<typeof readClient>>;
  try { client = await readClient(client_id); }
  catch (e) { return page(`<h1>Sign-in failed</h1><p class="sub">${escape(e instanceof SafeError ? e.message : 'Unknown client.')}</p>`, 400); }

  // Never redirect to an address this client did not register.
  if (!client.redirect_uris.includes(redirect_uri)) {
    return page('<h1>Sign-in failed</h1><p class="sub">That redirect address is not registered for this client.</p>', 400);
  }

  const state = url.searchParams.get('state');
  const response_type = url.searchParams.get('response_type');
  if (response_type !== 'code') return errorRedirect(redirect_uri, state, 'unsupported_response_type', 'Only response_type=code is supported.');

  const method = url.searchParams.get('code_challenge_method');
  const code_challenge = url.searchParams.get('code_challenge') || '';
  if (method !== 'S256') return errorRedirect(redirect_uri, state, 'invalid_request', 'code_challenge_method must be S256.');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(code_challenge)) return errorRedirect(redirect_uri, state, 'invalid_request', 'A valid S256 code_challenge is required.');

  return { params: { client_id, redirect_uri, state, code_challenge, scope: url.searchParams.get('scope') }, clientName: client.client_name };
}

export async function GET(request: Request) {
  const resolved = await resolve(new URL(request.url));
  if (resolved instanceof Response) return resolved;
  return form(resolved.params, resolved.clientName);
}

export async function POST(request: Request) {
  const submitted = await request.formData();
  const url = new URL(request.url);
  // Re-read every security-relevant value from the form, then validate it exactly as on GET.
  for (const key of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'scope']) {
    const value = submitted.get(key);
    if (typeof value === 'string' && value) url.searchParams.set(key, value);
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge_method', 'S256');

  const resolved = await resolve(url);
  if (resolved instanceof Response) return resolved;
  const { params, clientName } = resolved;

  const username = String(submitted.get('username') || '').trim();
  const password = String(submitted.get('password') || '');
  if (!username || !password || username.length > 100 || password.length > 400) {
    return form(params, clientName, 'Enter a username and password.');
  }

  const key = `${username}|${request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'}`;
  const seen = failures.get(key);
  if (seen && seen.until > Date.now() && seen.count >= MAX_FAILURES) {
    return form(params, clientName, 'Too many failed attempts. Wait 15 minutes.');
  }

  const user = await authenticateUser(username, password);
  if (!user) {
    failures.set(key, seen && seen.until > Date.now()
      ? { count: seen.count + 1, until: seen.until } : { count: 1, until: Date.now() + WINDOW_MS });
    return form(params, clientName, 'Invalid username or password.');
  }
  failures.delete(key);

  const scope = grantedScopes(params.scope, user.role);
  const code = await issueCode({ client_id: params.client_id, redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge, user: user.username, role: user.role, scope });

  const target = new URL(params.redirect_uri);
  target.searchParams.set('code', code);
  if (params.state) target.searchParams.set('state', params.state);
  return Response.redirect(target.toString(), 302);
}
