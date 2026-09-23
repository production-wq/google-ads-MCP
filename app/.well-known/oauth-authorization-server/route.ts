import { oauthEndpoint } from '../../../lib/oauth/runtime';
export { options as OPTIONS } from '../../../lib/oauth/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return oauthEndpoint('metadata', request); }
