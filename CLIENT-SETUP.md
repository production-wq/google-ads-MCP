# Local development and MCP client setup

This repository is a Node.js Streamable HTTP MCP server. The GitHub URL is
source code; a client connects to a running URL ending in `/api/mcp`.

For colleagues connecting the already deployed company server, use
[COLLEAGUE-CONNECTION-GUIDE.md](COLLEAGUE-CONNECTION-GUIDE.md). For the owner
deploying it, use [VERCEL-GUIDE.md](VERCEL-GUIDE.md).

## Local checks

Install Node.js 22 or newer:

```sh
npm ci
cp .env.example .env.local
npm run login:password
npm test
npm run typecheck
npm run build
```

The generated password hash is safe to put in `.env.local`; never commit the
plaintext password or any real Google credential.

For a quick CSV-only local check, set these values in `.env.local`:

```dotenv
MCP_AUTH_MODE=shared
MCP_RESOURCE_URL=http://localhost:3000/api/mcp
CSV_LOCAL_PATH=/absolute/path/to/data/budget.csv
MCP_API_KEYS_JSON={"local-client":"a-long-local-key-at-least-32-characters"}
```

The `shared` mode keeps the legacy API-key/JWT verifier for local testing. The
deployed company setup uses `shared-login`, Upstash Redis, and the company Sheet.

Start the server with:

```sh
npm run dev
```

The local endpoint is `http://localhost:3000/api/mcp`. Hosted ChatGPT and Claude
cannot reach your laptop's localhost; they need the deployed HTTPS URL.

## Connecting clients

### ChatGPT

Enable Developer mode if available, add a custom MCP/connector, and enter the
deployed URL ending in `/api/mcp`. Complete the company login page. Do not enter
the Google refresh token. Workspace policies can change where the connector
controls appear.

### Claude web

Open **Customize → Connectors → + → Add custom connector**, enter the deployed
URL, choose **Connect**, and complete the company login page. Team and Enterprise
workspaces may require an organization owner to allow the connector.

### Claude Code

For a local API-key test:

```sh
claude mcp add --transport http google-ads http://localhost:3000/api/mcp \
  --header "Authorization: Bearer YOUR_LOCAL_KEY"
```

For the hosted company server, use the URL without a static header if your
Claude Code version supports OAuth login, then complete its browser flow.

### Other AI applications

Use the application's **remote MCP / Streamable HTTP** option with the deployed
URL. Choose OAuth when offered. A client that only accepts a bearer header can
use the legacy API-key mode in a separate deployment, but the shared-login
deployment is intended for OAuth-capable clients.

## Verification limits

`npm test`, `npm run typecheck`, and `npm run build` use synthetic data or mocked
upstream calls. They do not prove the live Google credentials, Vercel URL, Redis,
or a hosted AI client's login flow. After deployment, connect one client, list
the worksheet accounts, then run a known-date report and compare it with Google
Ads.
