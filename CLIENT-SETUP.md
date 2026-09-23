# Run this MCP with ChatGPT, Claude and other clients

This repository is a read-only **Node.js HTTP MCP server**. It runs separately
from the AI application. The application calls its tools, which read a budget CSV
and Google Ads. A GitHub URL is not an MCP endpoint. Your endpoint is
`http://localhost:3000/api/mcp` locally, or
`https://YOUR-PROJECT.vercel.app/api/mcp` after deployment.

MCP support belongs to the application or agent framework, not to a model by
itself. An application must support the server's transport and authentication.
This project does not expose campaign edits or automatically update Google Sheets.

## 1. Prove the server works locally

Install Node.js 22+ and Git, then run:

```sh
git clone https://github.com/production-wq/google-ads-MCP.git
cd google-ads-MCP
npm ci
cp .env.example .env.local
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save the generated key privately. Create a local `data/budget.csv` file with this
synthetic content (create the `data` directory first):

```csv
Account name,Customer ID,Ad target spend,Comments
Example account,1234567890,1000,Local connection test only
```

Set these values in `.env.local`, replacing the placeholders:

```dotenv
MCP_RESOURCE_URL=http://localhost:3000/api/mcp
CSV_LOCAL_PATH=/absolute/path/to/google-ads-MCP/data/budget.csv
MCP_API_KEYS_JSON={"local-client":"PASTE_GENERATED_KEY_HERE"}
```

On Windows use an absolute path with forward slashes, such as
`C:/Users/you/google-ads-MCP/data/budget.csv`. Leave Google and OAuth settings blank
for this CSV-only check. Do not commit `.env.local` or your actual CSV.

```sh
npm test
npm run typecheck
npm run dev
```

Leave the server running. In a second terminal in the same folder:

```sh
npm run smoke
```

Expected: anonymous access rejected, MCP initialization and four read-only tools
discovered, and the example CSV account returned. This does **not** prove Google
Ads access. `npm run build` followed by `npm start` is the production alternative
to `npm run dev`. Do not launch the Python helpers for this application: their
separate Google Python MCP dependencies are not included.

## 2. Connect real Google Ads data

There are two separate authentication connections:

| Connection | Credentials | Purpose |
| --- | --- | --- |
| AI client → this server | A per-client API key, or an external OAuth provider | Authorizes the AI application to read this deployment |
| This server → Google Ads | Google OAuth client ID/secret, refresh token and developer token | Authorizes API requests to Google Ads |

A Google Ads refresh token is not an MCP client key. Signing into this MCP does
not switch which Google Ads user/account the deployment uses.

1. Obtain a developer token through a Google Ads manager account's API Center.
   Its access level must permit your intended test or production accounts.
2. Configure a Google Cloud OAuth client and consent screen for Google Ads API
   access. Use Google's documented OAuth flow to obtain a refresh token for an
   authorized Google Ads user with `https://www.googleapis.com/auth/adwords` scope.
   Prefer a read-only Ads user. The OAuth scope itself is not read-only.
3. Set the following server environment variables:

| Variable | Value |
| --- | --- |
| `GOOGLE_ADS_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_ADS_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_ADS_REFRESH_TOKEN` | Refresh token issued for that client/user |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Approved developer token |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Manager customer ID when accessing accounts through that manager |
| `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` | Comma-separated customer account IDs permitted for live queries |

4. Replace the example CSV with real accounts. Live queries require the customer
   ID in **both** the CSV and the allowlist. All authenticated users of this
   deployment can read the entire CSV, including notes; this is not per-client
   account isolation.
5. Restart locally, or redeploy after changing Vercel variables. Request a report
   for one known account and explicit dates; compare cost, clicks and conversions
   to Google Ads using the same dates, account time zone and conversion columns.

Google's setup guides: [OAuth](https://developers.google.com/google-ads/api/docs/oauth/overview),
[developer tokens](https://developers.google.com/google-ads/api/docs/api-policy/developer-token).

## 3. Deploy once for hosted AI applications

Follow [VERCEL-GUIDE.md](VERCEL-GUIDE.md): import this repository into Vercel,
connect a **private** Blob store, configure environment variables, and upload
your CSV with `npm run csv:upload -- "/path/to/budget.csv"`.

Use `MCP_RESOURCE_URL=https://YOUR-PROJECT.vercel.app/api/mcp` on the deployment.
Local `CSV_LOCAL_PATH` is ignored on Vercel. Updating a file on your computer
does not update the hosted CSV; upload it again.

For ChatGPT and Claude hosted connectors, configure an external MCP-compatible
OAuth provider. This repository verifies signed JWT access tokens; it does not
implement `/authorize`, `/token`, user signup, or client registration. Configure:

- `OAUTH_ISSUER`: exact issuer from the provider's metadata.
- `OAUTH_JWKS_URL`: the provider's HTTPS signing-key endpoint.
- `OAUTH_ALLOWED_SUBJECTS`: approved users' exact `sub` values, comma-separated.
- Audience/resource equal to `MCP_RESOURCE_URL`, and the `ads:read` scope.
- Authorization-code flow with PKCE and the client registration/redirect settings
  required by the intended AI client. Follow the provider's MCP-specific guide.

The verifier accepts RS256 or ES256 JWTs with issuer, audience, expiry and approved
subject. Opaque tokens or tokens with a different audience will not work.
An empty subject allowlist rejects every OAuth user. Do not select “No auth” to
work around incomplete setup; anonymous access is intentionally rejected.

## 4. Add the connection to an AI application

### ChatGPT

1. Enable Developer mode under **Settings → Security and login**, when available
   under your account/workspace policy.
2. Open **Plugins**, click **+**, and add the name and deployed URL ending in
   `/api/mcp`.
3. Complete OAuth sign-in and review the four discovered tools.
4. Enable the connection in a new conversation and ask: “List my worksheet accounts.”

Use the deployed URL, not GitHub or localhost. OpenAI also documents Secure MCP
Tunnel for private servers; that requires separate tunnel setup and permissions.
[Official instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).

### Claude web / remote connector

1. Open **Customize → Connectors → + → Add custom connector**.
2. Enter the deployed URL and complete OAuth. For Team/Enterprise, an owner must
   first add the connector under organization settings.
3. Enable the connector for the conversation and ask to list worksheet accounts.

These remote connections originate from Anthropic's cloud, including when used
through Claude Desktop. They cannot reach your laptop's localhost.
[Official instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

### Claude Code: quickest local connection

Claude Code can connect directly to the local HTTP server using a client key:

```sh
claude mcp add --transport http google-ads http://localhost:3000/api/mcp \
  --header "Authorization: Bearer YOUR_GENERATED_CLIENT_KEY"
```

Keep the key in private local configuration; never commit it. For a hosted OAuth
connection, use the deployed URL without the header and authenticate via `/mcp`.
If using JSON configuration, include `"type": "http"`; a URL alone is insufficient
in Claude Code. [Official instructions](https://code.claude.com/docs/en/mcp).

### Codex CLI / IDE

For a deployed OAuth connection:

```sh
codex mcp add google-ads --url https://YOUR-PROJECT.vercel.app/api/mcp
codex mcp login google-ads
```

For local API-key access, configure your private `~/.codex/config.toml`:

```toml
[mcp_servers.google_ads]
url = "http://localhost:3000/api/mcp"
bearer_token_env_var = "GOOGLE_ADS_MCP_CLIENT_KEY"
```

Set that environment variable to the generated client key before launching Codex.
[Official instructions](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Other AI applications and models

Choose a client that supports **Streamable HTTP MCP**, configure the same URL,
and use OAuth or a supported Authorization header. Configuration formats vary.
For a model exposed only through a generation API, your own agent application
must act as the MCP client and execute tool calls. Pasting the GitHub URL into a
chat does not install the tools. A stdio-only application needs a separately
configured HTTP-to-stdio MCP bridge; `npm run dev` is not a stdio MCP command.

## Troubleshooting and verification limits

| Symptom | Check |
| --- | --- |
| 401 | Missing/invalid client key, wrong JWT issuer/audience, expired token or unapproved subject |
| 403 | Missing `ads:read` scope or a browser Origin absent from `MCP_ALLOWED_ORIGINS` |
| OAuth metadata 503 | `OAUTH_ISSUER` or `MCP_RESOURCE_URL` not configured |
| HTML login screen instead of MCP | Vercel deployment protection is intercepting the request |
| CSV tool succeeds but Ads fails | Google credentials, developer-token access level, manager ID, CSV membership and allowlist |
| Hosted client cannot reach server | It needs a reachable HTTPS endpoint; localhost refers to the client's own machine |
| Old data | Re-upload the hosted CSV and start a report with its new version |

For a browser MCP client, set its exact origin(s) in `MCP_ALLOWED_ORIGINS`.
Server-to-server clients normally send no Origin and need no CORS entry.
Client API keys must have at least 32 characters; use a separately generated key
for each client. To revoke one, remove it and restart/redeploy.

Automated tests use synthetic CSVs and mocked Google/OAuth upstreams. They check
HTTP MCP initialization, tool discovery/dispatch, access rejection, JWT validation,
CSV handling and report arithmetic. A successful build/test run does not certify
your Vercel deployment, real Google credentials, or a hosted OAuth login. Verify
those with a live read-only account report after configuration.
