import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { SafeError } from './errors';

const scrypt = promisify(scryptCb) as (p: string | Buffer, s: Buffer, k: number) => Promise<Buffer>;
const SCRYPT_KEY_BYTES = 32;
const SESSION_ISSUER = 'google-ads-mcp';
const SESSION_AUDIENCE = 'google-ads-mcp-session';

export type Role = 'read' | 'write';
export const SCOPES: Record<Role, string[]> = { read: ['ads:read'], write: ['ads:read', 'ads:write'] };

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ---------------------------------------------------------------- passwords */

/** `scrypt$<salt base64>$<hash base64>`. No database: the hash lives in an env var. */
export async function hashPassword(password: string) {
  if (password.length < 12) throw new SafeError('Password must be at least 12 characters.');
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(password, salt, SCRYPT_KEY_BYTES)).toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length || SCRYPT_KEY_BYTES);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

export type User = { password_hash: string; role: Role };
export function loadUsers(): Record<string, User> {
  let parsed: unknown;
  try { parsed = JSON.parse(process.env.MCP_USERS_JSON || '{}'); } catch { return {}; }
  const users: Record<string, User> = {};
  for (const [name, value] of Object.entries((parsed ?? {}) as Record<string, unknown>)) {
    const entry = value as { password_hash?: unknown; role?: unknown };
    if (typeof entry?.password_hash !== 'string' || !entry.password_hash.startsWith('scrypt$')) continue;
    users[name] = { password_hash: entry.password_hash, role: entry.role === 'write' ? 'write' : 'read' };
  }
  return users;
}

/* ----------------------------------------------------------------- sessions */

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new SafeError('Missing server configuration: SESSION_SECRET (32+ characters).');
  return new TextEncoder().encode(secret);
}
export function sessionTtlSeconds() {
  const hours = Number(process.env.SESSION_TTL_HOURS || 720);
  return (Number.isFinite(hours) && hours > 0 && hours <= 8760 ? hours : 720) * 3600;
}
/** Signed, self-contained session token. Revoke by rotating SESSION_SECRET or removing the user. */
export async function issueSession(username: string, role: Role) {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionTtlSeconds();
  const token = await new SignJWT({ role, scope: SCOPES[role].join(' ') })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(SESSION_ISSUER).setAudience(SESSION_AUDIENCE)
    .setSubject(username).setIssuedAt().setExpirationTime(expiresAt).sign(sessionSecret());
  return { token, expires_at: new Date(expiresAt * 1000).toISOString() };
}

/** Verifies a username and password against the env-var user list. */
export async function authenticateUser(username: string, password: string) {
  const user = loadUsers()[username];
  // Always spend the hashing cost so a missing user is not faster than a wrong password.
  const reference = user?.password_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const valid = await verifyPassword(password, reference);
  if (!user || !valid) return undefined;
  return { username, role: user.role };
}

/* ------------------------------------------------------------ token gateway */

export function verifyClaims(payload: JWTPayload): boolean {
  const allowed = (process.env.OAUTH_ALLOWED_SUBJECTS || '').split(',').map(s => s.trim()).filter(Boolean);
  return !!payload.sub && allowed.includes(payload.sub) && typeof payload.exp === 'number';
}

/** Static client keys. A plain string value stays read-only; an object may grant writes. */
function apiKeyIdentity(token: string): AuthInfo | undefined {
  let keys: Record<string, unknown>;
  try { keys = JSON.parse(process.env.MCP_API_KEYS_JSON || '{}'); } catch { return; }
  for (const [clientId, value] of Object.entries(keys)) {
    const secret = typeof value === 'string' ? value : (value as { key?: unknown })?.key;
    const role: Role = typeof value === 'object' && (value as { role?: unknown })?.role === 'write' ? 'write' : 'read';
    if (typeof secret === 'string' && secret.length >= 32 && safeEqual(token, secret)) {
      return { token, clientId, scopes: SCOPES[role] };
    }
  }
}

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyToken(_request: Request, token?: string): Promise<AuthInfo | undefined> {
  if (!token) return;
  try {
    const key = apiKeyIdentity(token);
    if (key) return key;

    if (process.env.SESSION_SECRET && token.split('.').length === 3) {
      try {
        const { payload } = await jwtVerify(token, sessionSecret(), {
          issuer: SESSION_ISSUER, audience: SESSION_AUDIENCE, algorithms: ['HS256'], requiredClaims: ['exp', 'sub'],
        });
        // A session is only as current as the user list: a removed user stops working.
        const user = payload.sub ? loadUsers()[payload.sub] : undefined;
        if (user) return { token, clientId: String(payload.sub), scopes: SCOPES[user.role], expiresAt: payload.exp };
      } catch { /* fall through to the external issuer */ }
    }

    const issuer = process.env.OAUTH_ISSUER, jwks = process.env.OAUTH_JWKS_URL;
    const audience = process.env.MCP_RESOURCE_URL;
    if (!issuer || !jwks || !audience || !jwks.startsWith('https://')) return;
    if (!keysets.has(jwks)) keysets.set(jwks, createRemoteJWKSet(new URL(jwks)));
    const { payload } = await jwtVerify(token, keysets.get(jwks)!, {
      issuer, audience, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'sub'],
    });
    if (!verifyClaims(payload)) return;
    return { token, clientId: String(payload.azp || payload.client_id || payload.sub),
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [], expiresAt: payload.exp };
  } catch { return; }
}

/** The signed-in identity for a tool call, used for scope checks and the audit trail. */
export function actor(authInfo: AuthInfo | undefined) {
  return { user: authInfo?.clientId || 'unknown', scopes: authInfo?.scopes || [] };
}
export function requireWrite(authInfo: AuthInfo | undefined) {
  if (!(authInfo?.scopes || []).includes('ads:write')) {
    throw new SafeError('This account is read-only. A user with the write role must perform changes.');
  }
  return actor(authInfo);
}
