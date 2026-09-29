import { issueSession, loadUsers, sessionTtlSeconds } from '../../../lib/auth';
import { checkPkce, issueRefresh, readCode, readRefresh } from '../../../lib/oauth';
import { SafeError } from '../../../lib/errors';

export const dynamic = 'force-dynamic';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};
const fail = (error: string, description: string, status = 400) =>
  Response.json({ error, error_description: description }, { status, headers: cors });

/** Accepts form encoding, which the spec requires, and JSON, which some clients send anyway. */
async function readBody(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const body = await request.json().catch(() => ({}));
    return Object.fromEntries(Object.entries(body as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string') as [string, string][]);
  }
  const form = await request.formData();
  return Object.fromEntries([...form.entries()]
    .filter(([, v]) => typeof v === 'string') as [string, string][]);
}

export async function POST(request: Request) {
  let body: Record<string, string>;
  try { body = await readBody(request); }
  catch { return fail('invalid_request', 'Could not read the request body.'); }

  try {
    if (body.grant_type === 'authorization_code') {
      const { code, code_verifier, redirect_uri, client_id } = body;
      if (!code || !code_verifier) return fail('invalid_request', 'code and code_verifier are required.');
      const granted = await readCode(code);
      // The code is bound to the client and redirect it was issued for.
      if (client_id && client_id !== granted.client_id) return fail('invalid_grant', 'This code was issued to a different client.');
      if (redirect_uri && redirect_uri !== granted.redirect_uri) return fail('invalid_grant', 'redirect_uri does not match the one used to obtain the code.');
      checkPkce(code_verifier, granted.code_challenge);

      // The role is re-read now, so a demoted or removed user cannot redeem an older code.
      const user = loadUsers()[granted.user];
      if (!user) return fail('invalid_grant', 'That account no longer exists.');

      const session = await issueSession(granted.user, user.role, granted.scope);
      return Response.json({
        access_token: session.token, token_type: 'Bearer', expires_in: sessionTtlSeconds(),
        refresh_token: await issueRefresh(granted.user, granted.client_id, granted.scope),
        scope: session.scope,
      }, { headers: cors });
    }

    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) return fail('invalid_request', 'refresh_token is required.');
      const previous = await readRefresh(body.refresh_token);
      const user = loadUsers()[previous.user];
      if (!user) return fail('invalid_grant', 'That account no longer exists.');
      // Scopes come from the role as it stands now, so a promotion to write takes
      // effect on the next refresh and a demotion likewise, without reconnecting.
      const session = await issueSession(previous.user, user.role);
      return Response.json({
        access_token: session.token, token_type: 'Bearer', expires_in: sessionTtlSeconds(),
        refresh_token: await issueRefresh(previous.user, previous.client_id, session.scope),
        scope: session.scope,
      }, { headers: cors });
    }

    return fail('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  } catch (e) {
    return fail('invalid_grant', e instanceof SafeError ? e.message : 'The grant could not be verified.');
  }
}
export function OPTIONS() { return new Response(null, { status: 204, headers: cors }); }
