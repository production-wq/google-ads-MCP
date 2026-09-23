import { authenticatedHandler } from '../../../lib/mcp';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(request: Request) {
  const origin = request.headers.get('origin');
  const allowed = (process.env.MCP_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  // Most MCP clients are server-to-server and send no Origin.
  if (origin && !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
  const response = await authenticatedHandler(request);
  response.headers.set('Cache-Control', 'no-store');
  if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
  return response;
}
export { handle as GET, handle as POST, handle as DELETE };
export function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || !(process.env.MCP_ALLOWED_ORIGINS || '').split(',').includes(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'WWW-Authenticate', Vary: 'Origin',
  } });
}
