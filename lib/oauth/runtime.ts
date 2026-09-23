import { sharedLoginMode, oauthConfig } from './config';
import { OAuthFailure, OAuthService, json } from './service';
import { RedisStore } from './store';
export function oauthService() {
  const config = oauthConfig();
  return new OAuthService(config, new RedisStore());
}
export type OAuthAction = 'metadata' | 'register' | 'authorize' | 'consent' | 'token' | 'revoke';
export async function oauthEndpoint(action: OAuthAction, request: Request) {
  try {
    if (!sharedLoginMode()) return json({ error: 'not_found' }, 404);
    const service = oauthService();
    if (action === 'metadata') return service.metadata();
    return await service[action](request);
  } catch (error) {
    if (error instanceof OAuthFailure) return json({ error: error.code, error_description: error.message }, error.status);
    return json({ error: 'temporarily_unavailable', error_description: 'Connection service unavailable. Ask the owner to check company login and Redis configuration.' }, 503);
  }
}
