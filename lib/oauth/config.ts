export function sharedLoginMode() {
  const mode = process.env.MCP_AUTH_MODE || 'shared';
  if (!['shared', 'shared-login'].includes(mode)) throw new Error('Invalid MCP_AUTH_MODE.');
  return mode === 'shared-login';
}
export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}
export function oauthConfig() {
  const resource = new URL(required('MCP_RESOURCE_URL'));
  if (resource.protocol !== 'https:' || resource.pathname !== '/api/mcp' || resource.search || resource.hash || resource.username || resource.password) {
    throw new Error('MCP_RESOURCE_URL must be an HTTPS URL ending in /api/mcp.');
  }
  const username = required('MCP_LOGIN_USERNAME');
  const passwordHash = required('MCP_LOGIN_PASSWORD_HASH');
  if (!/^scrypt:[a-f\d]{32}:[a-f\d]{128}$/i.test(passwordHash)) throw new Error('Generate MCP_LOGIN_PASSWORD_HASH with npm run login:password.');
  return { resource: resource.href, origin: resource.origin, username, passwordHash };
}
export type Config = ReturnType<typeof oauthConfig>;
export const ACCESS_TTL = 900;
export const GRANT_TTL = 30 * 24 * 3600;
export const FLOW_TTL = 600;
