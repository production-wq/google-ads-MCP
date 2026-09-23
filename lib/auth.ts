import { sharedLoginMode } from './oauth/config';
import { oauthService } from './oauth/runtime';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';

export function verifyClaims(payload: JWTPayload): boolean {
  const allowed = (process.env.OAUTH_ALLOWED_SUBJECTS || '').split(',').map(s => s.trim()).filter(Boolean);
  return !!payload.sub && allowed.includes(payload.sub) && typeof payload.exp === 'number';
}
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyToken(_request: Request, token?: string): Promise<AuthInfo | undefined> {
  if (!token) return;
  try {
    if (sharedLoginMode()) {
      const access = await oauthService().verifyAccess(token);
      return access ? { token, clientId: access.clientId, scopes: ['ads:read'], expiresAt: access.expiresAt } : undefined;
    }
    // Each value is a separate revocable credential for a trusted client.
    const keys = JSON.parse(process.env.MCP_API_KEYS_JSON || '{}') as Record<string, string>;
    for (const [clientId, secret] of Object.entries(keys)) {
      if (typeof secret === 'string' && secret.length >= 32 && safeEqual(token, secret)) {
        return { token, clientId, scopes: ['ads:read'] };
      }
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
