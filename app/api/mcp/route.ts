import { authenticatedHandler } from '../../../lib/mcp';
import { originAllowed } from '../../../lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(request: Request) {
  const origin = request.headers.get('origin');
  // Hosted connectors are server-to-server but still send an Origin; bearer auth
  // is what protects this endpoint, so only an explicit allowlist restricts it.
  if (!originAllowed(origin)) return new Response('Origin not allowed', { status: 403 });
  const response = await authenticatedHandler(request);
  response.headers.set('Cache-Control', 'no-store');
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
  }
  return response;
}
export { handle as GET, handle as POST, handle as DELETE };

export function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  if (!originAllowed(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  } });
}
