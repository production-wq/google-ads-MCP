import { authenticateUser, issueSession, loadUsers } from '../../../lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Per-instance throttle. Serverless instances do not share it, so it slows a
 * brute-force attempt rather than stopping one; the real protection is a long
 * password and a short user list.
 */
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60 * 1000, MAX_FAILURES = 10;
function throttled(key: string) {
  const entry = failures.get(key);
  if (entry && entry.until > Date.now() && entry.count >= MAX_FAILURES) return true;
  if (entry && entry.until <= Date.now()) failures.delete(key);
  return false;
}
function recordFailure(key: string) {
  const entry = failures.get(key);
  failures.set(key, entry && entry.until > Date.now()
    ? { count: entry.count + 1, until: entry.until } : { count: 1, until: Date.now() + WINDOW_MS });
}

export async function POST(request: Request) {
  if (!Object.keys(loadUsers()).length) {
    return Response.json({ error: 'No users are configured. Set MCP_USERS_JSON.' }, { status: 503 });
  }
  let body: { username?: unknown; password?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: 'Send JSON with username and password.' }, { status: 400 }); }
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password || username.length > 100 || password.length > 400) {
    return Response.json({ error: 'Send JSON with username and password.' }, { status: 400 });
  }

  const key = `${username}|${request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'}`;
  if (throttled(key)) {
    return Response.json({ error: 'Too many failed attempts. Wait 15 minutes.' }, { status: 429, headers: { 'Retry-After': '900' } });
  }

  const user = await authenticateUser(username, password);
  if (!user) {
    recordFailure(key);
    // One message for both cases, so it never reveals which usernames exist.
    return Response.json({ error: 'Invalid username or password.' }, { status: 401 });
  }
  failures.delete(key);
  const session = await issueSession(user.username, user.role);
  return Response.json({
    username: user.username, role: user.role, can_write: user.role === 'write',
    token: session.token, expires_at: session.expires_at,
    endpoint: process.env.MCP_RESOURCE_URL || null,
  }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}

export function GET() {
  return Response.json({ error: 'POST JSON with username and password, or open /login in a browser.' }, { status: 405 });
}
