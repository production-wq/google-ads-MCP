import { authenticatedHandler } from '../../../lib/mcp';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const exposedHeaders = 'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version';
function allowedOrigins() {
  return (process.env.MCP_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
}
async function handle(request: Request) {
  const origin = request.headers.get('origin');
  // Most MCP clients are server-to-server and send no Origin.
  if (origin && !allowedOrigins().includes(origin)) return new Response('Origin not allowed', {
    status: 403, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' },
  });
  const response = await authenticatedHandler(request);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.append('Vary', 'Origin');
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    // Browsers need this on the actual response, including a 401 challenge.
    response.headers.set('Access-Control-Expose-Headers', exposedHeaders);
  }
  return response;
}
export { handle as GET, handle as POST, handle as DELETE };
export function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins().includes(origin)) return new Response(null, {
    status: 403, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' },
  });
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
    'Cache-Control': 'no-store', Vary: 'Origin',
  } });
}
