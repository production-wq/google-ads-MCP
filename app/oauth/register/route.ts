import { registerClient } from '../../../lib/oauth';
import { SafeError } from '../../../lib/errors';

export const dynamic = 'force-dynamic';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

/** RFC 7591 dynamic client registration. The client_id is signed, so nothing is stored. */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'invalid_client_metadata', error_description: 'Body must be JSON.' }, { status: 400, headers: cors }); }
  try {
    const client = await registerClient(body);
    return Response.json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }, { status: 201, headers: cors });
  } catch (e) {
    const message = e instanceof SafeError ? e.message : 'Could not register this client.';
    return Response.json({ error: 'invalid_client_metadata', error_description: message }, { status: 400, headers: cors });
  }
}
export function OPTIONS() { return new Response(null, { status: 204, headers: cors }); }
