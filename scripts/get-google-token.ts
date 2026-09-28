import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { GOOGLE_SCOPES } from '../lib/google-auth';

/** Writes the secret straight to .env.local so it never appears on screen. */
function saveToEnvFile(key: string, value: string) {
  const path = '.env.local';
  if (!existsSync(path)) { writeFileSync(path, `${key}=${value}\n`); return path; }
  const lines = readFileSync(path, 'utf8').split('\n');
  const index = lines.findIndex(line => line.startsWith(`${key}=`));
  if (index >= 0) lines[index] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  writeFileSync(path, lines.join('\n'));
  return path;
}

/**
 * Mints the one refresh token this service needs, carrying both the Google Ads
 * and Google Sheets scopes. Create an OAuth client of type "Desktop app" in the
 * Google Cloud project, then run this with its ID and secret.
 */
const clientId = process.argv[2] || process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = process.argv[3] || process.env.GOOGLE_ADS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Usage: npm run google:token -- <client-id> <client-secret>');
  console.error('Or set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in .env.local.');
  process.exit(1);
}

const PORT = 53682;
const redirectUri = `http://localhost:${PORT}/`;
const state = randomBytes(16).toString('hex');
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
  scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
  include_granted_scopes: 'true', state,
}).toString();

console.log('\n1. Add this exact redirect URI to the OAuth client in Google Cloud:\n   ' + redirectUri);
console.log('\n2. Open this URL, signed in as the Google account that has access to the Ads manager account AND the master Sheet:\n');
console.log('   ' + authUrl.toString() + '\n');

const WAIT_MINUTES = Number(process.env.OAUTH_WAIT_MINUTES || 15);
const code: string = await new Promise<string>((resolve, reject) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', redirectUri);
    const received = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const done = (message: string) => {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(message);
      server.close();
    };
    if (error) { done(`Authorization failed: ${error}`); return reject(new Error(`Google returned "${error}".`)); }
    if (!received) { response.writeHead(404); return response.end(); }
    if (url.searchParams.get('state') !== state) {
      // Nearly always a link left over from an earlier run. Say so and keep waiting
      // for the current one, rather than ending the whole attempt.
      console.log('Ignored a callback from an earlier attempt (state mismatch). Open the URL printed above instead.');
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return response.end('This sign-in link came from an earlier attempt, so it was ignored.\n\n'
        + 'Go back to your terminal and open the most recent URL it printed.');
    }
    done('Done. Return to your terminal; you can close this tab.');
    resolve(received);
  });
  server.on('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use — another copy of this script is probably still running.` : e.message)));
  server.listen(PORT, '127.0.0.1', () => console.log(`Waiting up to ${WAIT_MINUTES} minutes for the redirect on ${redirectUri} …\n`));
  setTimeout(() => { server.close(); reject(new Error(`Nobody opened the link within ${WAIT_MINUTES} minutes.`)); },
    WAIT_MINUTES * 60_000).unref();
}).catch((e: Error) => {
  // A clean message beats an unhandled rejection stack trace.
  console.error('\n' + e.message);
  console.error('Nothing was changed. Run "npm run google:token" again when you are ready to click through.\n');
  process.exit(1);
});

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code' }),
});
const data = await response.json();
if (!response.ok || !data.refresh_token) {
  console.error('Token exchange failed.', response.status, data.error_description || data.error || '');
  console.error('If there is no refresh_token, revoke this app at https://myaccount.google.com/permissions and run again.');
  process.exit(1);
}
const granted: string[] = String(data.scope || '').split(' ');
const missing = GOOGLE_SCOPES.filter(s => !granted.includes(s));
const token: string = data.refresh_token;

if (process.argv.includes('--print')) {
  console.log('\nGOOGLE_ADS_REFRESH_TOKEN=' + token);
} else {
  const path = saveToEnvFile('GOOGLE_ADS_REFRESH_TOKEN', token);
  console.log(`\nSaved GOOGLE_ADS_REFRESH_TOKEN to ${path} (${token.length} characters, starting ${token.slice(0, 6)}…).`);
  console.log('Re-run with --print if you need the value itself, for example to paste into Vercel.');
}
console.log('\nGranted scopes: ' + granted.join(', '));
if (missing.length) console.log('\nWARNING: missing scope(s): ' + missing.join(', ') + '. Re-run and approve every box.');
else console.log('Both the Google Ads and Google Sheets scopes are present.');
console.log('\nTreat this token as a password. Next: npm run setup:check\n');
