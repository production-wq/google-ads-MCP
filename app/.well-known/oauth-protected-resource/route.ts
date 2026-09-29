import { SUPPORTED_SCOPES, issuerOrigin } from '../../../lib/oauth';

export const dynamic = 'force-dynamic';

/**
 * RFC 9728. Points MCP clients at whichever authorization server is in use:
 * an external provider when OAUTH_ISSUER is set, otherwise this app's own.
 */
export function GET(request: Request) {
  const origin = issuerOrigin(request);
  const resource = process.env.MCP_RESOURCE_URL || `${origin}/api/mcp`;
  const issuer = process.env.OAUTH_ISSUER || origin;
  return Response.json({
    resource,
    authorization_servers: [issuer],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Google Ads Worksheet MCP',
  }, { headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}
