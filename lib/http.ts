/**
 * Origin policy for the MCP endpoint.
 *
 * Authentication is a bearer token in a header, never a cookie, so a browser
 * cannot make an authenticated cross-origin request on a user's behalf: there is
 * no ambient credential to ride along. An Origin allowlist therefore adds no
 * protection here, while it does break legitimate server-side clients — Claude's
 * and ChatGPT's hosted connectors both send an Origin.
 *
 * So the allowlist is opt-in hardening: set MCP_ALLOWED_ORIGINS to restrict
 * browser callers, leave it empty to accept any.
 */
export function originAllowed(origin: string | null): boolean {
  if (!origin) return true;
  const allowed = (process.env.MCP_ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(origin);
}
