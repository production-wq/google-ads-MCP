import { jwtVerify, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { SafeError } from './errors';

const AUDIENCE = 'google-ads-mcp-confirm';
const ISSUER = 'google-ads-mcp';

/** Everything needed to apply a change, carried inside the signed confirm token. */
export type Plan = {
  tool: string;
  customer_id: string;
  summary: string;
  /** Google Ads service to call, or 'atomic' for a multi-resource googleAds:mutate. */
  target: string;
  operations: object[];
  /** Human-readable before/after, shown in the preview and written to the audit log. */
  changes: unknown;
  warnings?: string[];
};

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new SafeError('Missing server configuration: SESSION_SECRET (32+ characters).');
  return new TextEncoder().encode(value);
}
export function confirmTtlSeconds() {
  const seconds = Number(process.env.CONFIRM_TTL_SECONDS || 600);
  return Number.isFinite(seconds) && seconds >= 60 && seconds <= 3600 ? seconds : 600;
}
export function planFingerprint(plan: Plan) {
  return createHash('sha256').update(JSON.stringify([plan.tool, plan.customer_id, plan.operations])).digest('hex').slice(0, 16);
}

/**
 * Signs the plan so the second call cannot change it. The token is bound to the
 * user who previewed it, so one person's preview is not another's authority.
 */
export async function issueConfirm(plan: Plan, user: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + confirmTtlSeconds();
  const confirm_token = await new SignJWT({ plan })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience(AUDIENCE)
    .setSubject(user).setIssuedAt().setExpirationTime(expiresAt).sign(secret());
  return { confirm_token, confirm_expires_at: new Date(expiresAt * 1000).toISOString(),
    plan_fingerprint: planFingerprint(plan) };
}

/**
 * Returns the plan from the token itself. Tool arguments are deliberately
 * ignored on the confirm call: what was previewed is what gets applied.
 */
export async function readConfirm(token: string, user: string, tool: string): Promise<Plan> {
  let plan: Plan;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'], requiredClaims: ['exp', 'sub'],
    });
    if (payload.sub !== user) throw new Error('subject mismatch');
    plan = payload.plan as Plan;
    if (!plan || typeof plan.tool !== 'string' || !Array.isArray(plan.operations)) throw new Error('malformed plan');
  } catch {
    throw new SafeError(`Confirmation token is invalid, expired (${Math.round(confirmTtlSeconds() / 60)} minute limit), or was issued to a different user. Preview the change again.`);
  }
  if (plan.tool !== tool) throw new SafeError(`Confirmation token belongs to ${plan.tool}, not ${tool}. Preview the change again.`);
  return plan;
}
