# Company Google Ads MCP

This is a read-only Node.js HTTP MCP server for one company's Google Ads
account and Google Sheet. It runs on Vercel and is used by hosted AI clients
through the deployed `/api/mcp` URL.

**Colleague connection steps:** [COLLEAGUE-CONNECTION-GUIDE.md](COLLEAGUE-CONNECTION-GUIDE.md)

**Owner deployment steps:** [VERCEL-GUIDE.md](VERCEL-GUIDE.md)

**Local/client details:** [CLIENT-SETUP.md](CLIENT-SETUP.md)

## What it exposes

| Tool | Purpose |
| --- | --- |
| `worksheet_accounts` | Read the configured budget sheet accounts and targets |
| `google_sheet_tabs` | List tabs in the one configured company Sheet |
| `google_sheet_read` | Read a bounded range from that Sheet |
| `google_ads_field_metadata` | Check Google Ads fields before writing GAQL |
| `google_ads_search` | Run a bounded read-only GAQL query |
| `worksheet_account_report` | Read cost, clicks, impressions, conversions and derived metrics |

No campaign mutation tools or Google Sheet write tools are exposed.

## Authentication model

The recommended deployment mode is `MCP_AUTH_MODE=shared-login`:

1. A colleague connects ChatGPT, Claude, or another OAuth-capable MCP client to
   the deployed URL.
2. The MCP shows a company username/password page.
3. The MCP issues a short-lived access token to that client.
4. The server uses its own Google refresh token to read the one configured Ads
   account and Sheet.

Colleagues never need Google OAuth, and the Google refresh token is never sent
   to an AI client. Anyone who receives the shared company login can read the
   same configured data, so distribute it only inside the company and rotate it
   with `npm run login:password` if it is exposed.

The server stores OAuth clients and tokens in Upstash Redis. Redis is required
for a Vercel deployment because function instances are not durable storage.

## Data configuration

Set `GOOGLE_SHEETS_SPREADSHEET_ID` and `GOOGLE_SHEETS_BUDGET_RANGE` for the one
company Sheet. `worksheet_accounts` reads that range as CSV-shaped rows. The
optional private Blob CSV remains as a legacy fallback when no Sheet ID is set.
The range must include `Account name`, `Customer ID`, and `Ad target spend`
headers; `Comments` is optional.

The server Google refresh token must be authorized for both:

- `https://www.googleapis.com/auth/adwords`
- `https://www.googleapis.com/auth/spreadsheets.readonly`

Also set the Google Ads developer token, optional manager login customer ID,
and `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` with the one account ID. The account must
also appear in the budget sheet's `Customer ID` column.

## Local development

Requires Node.js 22+.

```sh
npm ci
cp .env.example .env.local
npm run login:password
npm run typecheck
npm test
npm run build
```

For a local CSV-only check, use `CSV_LOCAL_PATH` and an API key instead of the
shared-login variables. For a realistic shared-login test, use HTTPS and a
temporary Upstash Redis database; the browser cookie is intentionally secure.

The Python files in this repository are not entry points for this Next.js
server. A running deployment, not the GitHub repository, is the MCP endpoint.
