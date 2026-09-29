import { jwtVerify, SignJWT } from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';
import { SafeError } from './errors';
import { SCOPES, type Role } from './auth';

/**
 * A small OAuth 2.1 authorization server, enough for MCP clients that insist on
 * OAuth and cannot send a static header. It stores nothing: every artefact a
 * database would normally hold is a signed, expiring token instead.
 *
 *   client_id          signed, carries the client's redirect URIs
 *   authorization code signed, carries the user, role and PKCE challenge
 *   access token       the same session JWT the password login issues
 *   refresh token      signed, carries the user only
 */

const ISSUER = 'google-ads-mcp';
const AUD_CLIENT = 'google-ads-mcp-client';
const AUD_CODE = 'google-ads-mcp-code';
const AUD_REFRESH = 'google-ads-mcp-refresh';

export const SUPPORTED_SCOPES = ['ads:read', 'ads:write'];
const CODE_TTL_SECONDS = 60;

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new SafeError('Missing server configuration: SESSION_SECRET (32+ characters).');
  return new TextEncoder().encode(value);
}
export function refreshTtlSeconds() {
  const days = Number(process.env.OAUTH_REFRESH_TTL_DAYS || 90);
  return (Number.isFinite(days) && days > 0 && days <= 365 ? days : 90) * 86400;
}

/** The public origin of this deployment, used as the OAuth issuer. */
export function issuerOrigin(request: Request) {
  const configured = process.env.MCP_RESOURCE_URL;
  if (configured) { try { return new URL(configured).origin; } catch { /* fall through */ } }
  const forwarded = request.headers.get('x-forwarded-host');
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  if (forwarded) return `${proto}://${forwarded.split(',')[0].trim()}`;
  return new URL(request.url).origin;
}

/* ------------------------------------------------- client registration */

/**
 * Redirect URIs are the only thing that stops an attacker sending a code to
 * themselves, so they are restricted to loopback (what desktop MCP clients use)
 * and https. A registered set is sealed into the client_id.
 */
export function validateRedirectUri(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) throw new SafeError('Each redirect_uri must be a string.');
  let url: URL;
  try { url = new URL(value); } catch { throw new SafeError(`redirect_uri is not a valid URL: ${value.slice(0, 80)}`); }
  if (url.hash) throw new SafeError('redirect_uri must not contain a fragment.');
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (url.protocol === 'http:' && !loopback) throw new SafeError('redirect_uri must use https, or http on localhost.');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // Desktop clients sometimes register a private scheme; allow it if it looks like one.
    if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) throw new SafeError('redirect_uri scheme is not supported.');
  }
  return value;
}

export async function registerClient(input: { client_name?: unknown; redirect_uris?: unknown }) {
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  if (!uris.length) throw new SafeError('redirect_uris is required and must list at least one URI.');
  if (uris.length > 10) throw new SafeError('At most 10 redirect_uris.');
  const redirect_uris = uris.map(validateRedirectUri);
  const client_name = typeof input.client_name === 'string' ? input.client_name.slice(0, 120) : 'MCP client';
  // No expiry: a client that registered once keeps working across redeploys.
  const client_id = await new SignJWT({ redirect_uris, client_name })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience(AUD_CLIENT)
    .setIssuedAt().sign(secret());
  return { client_id, client_name, redirect_uris };
}

export async function readClient(client_id: string) {
  try {
    const { payload } = await jwtVerify(client_id, secret(), { issuer: ISSUER, audience: AUD_CLIENT, algorithms: ['HS256'] });
    const uris = payload.redirect_uris;
    if (!Array.isArray(uris) || !uris.length) throw new Error('no redirect_uris');
    return { redirect_uris: uris as string[], client_name: String(payload.client_name || 'MCP client') };
  } catch {
    throw new SafeError('Unknown or malformed client_id. Register the client again.');
  }
}

/* ----------------------------------------------------------- PKCE + codes */

export function checkPkce(verifier: string, challenge: string) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new SafeError('code_verifier must be 43 to 128 unreserved characters.');
  const actual = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(actual), b = Buffer.from(challenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new SafeError('code_verifier does not match the code_challenge.');
}

/**
 * The user's role is the authority, so a sign-in grants exactly what that role
 * allows. A narrower `scope` on the request is not honoured, deliberately: the
 * endpoint's 401 challenge advertises `ads:read` as its requirement, so clients
 * ask for `ads:read` alone, and honouring that would leave every write user
 * holding a read-only token. RFC 6749 section 3.3 permits granting a different
 * scope than requested; the token response reports what was actually granted.
 *
 * The role remains a ceiling: a read user never receives ads:write, whatever
 * the request asks for.
 */
export function grantedScopes(_requested: string | null, role: Role) {
  return SCOPES[role].join(' ');
}

export async function issueCode(input: {
  client_id: string; redirect_uri: string; code_challenge: string; user: string; role: Role; scope: string;
}) {
  return new SignJWT({ ...input })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience(AUD_CODE)
    .setSubject(input.user).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS)
    .sign(secret());
}

export async function readCode(code: string) {
  try {
    const { payload } = await jwtVerify(code, secret(), { issuer: ISSUER, audience: AUD_CODE, algorithms: ['HS256'], requiredClaims: ['exp'] });
    return payload as unknown as { client_id: string; redirect_uri: string; code_challenge: string; user: string; role: Role; scope: string };
  } catch {
    throw new SafeError(`Authorization code is invalid or older than ${CODE_TTL_SECONDS} seconds. Start the sign-in again.`);
  }
}

export async function issueRefresh(user: string, client_id: string, scope: string) {
  return new SignJWT({ client_id, scope })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience(AUD_REFRESH)
    .setSubject(user).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + refreshTtlSeconds())
    .sign(secret());
}
export async function readRefresh(token: string) {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience: AUD_REFRESH, algorithms: ['HS256'], requiredClaims: ['exp', 'sub'] });
    return { user: String(payload.sub), client_id: String(payload.client_id || ''), scope: String(payload.scope || '') };
  } catch {
    throw new SafeError('Refresh token is invalid or expired. Sign in again.');
  }
}

/** Errors go back to the client as a redirect when we trust the redirect_uri, per RFC 6749. */
export function errorRedirect(redirectUri: string, state: string | null, error: string, description: string) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description.slice(0, 200));
  if (state) url.searchParams.set('state', state);
  return Response.redirect(url.toString(), 302);
}
