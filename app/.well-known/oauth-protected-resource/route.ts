import { sharedLoginMode } from '../../../lib/oauth/config';
import { oauthService } from '../../../lib/oauth/runtime';
export const dynamic = 'force-dynamic';
export function GET() {
  try { if (sharedLoginMode()) return oauthService().resourceMetadata(); }
  catch { return Response.json({ error: 'Company login is not configured.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  const resource = process.env.MCP_RESOURCE_URL, issuer = process.env.OAUTH_ISSUER;
  if (!resource || !issuer) return Response.json({ error: 'OAuth has not been configured. Use an API-key-capable client.' }, { status: 503 });
  return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ['ads:read'],
    bearer_methods_supported: ['header'], resource_name: 'Google Ads Worksheet MCP' },
  { headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}
