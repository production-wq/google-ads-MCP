# Publish and configure the company MCP

This deployment is designed for one company Google Ads account and one
Google Sheet. The server owner completes these steps once. Colleagues then use
the short [connection guide](COLLEAGUE-CONNECTION-GUIDE.md).

## 1. Deploy to Vercel

Import this repository into Vercel, select the Next.js framework, and use Node.js
22 or newer. The production MCP URL is:

`https://YOUR-PROJECT.vercel.app/api/mcp`

Set `MCP_RESOURCE_URL` to that exact URL, including `/api/mcp`. Do not enable
Vercel Deployment Protection for the MCP URL unless the AI client can pass the
additional Vercel protection check; the application has its own login.

## 2. Create durable OAuth storage

Create an Upstash Redis database and add these Vercel environment variables:

| Variable | Value |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | The database HTTPS REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | The database REST token |

Redis stores dynamic MCP client registrations, browser login transactions,
access tokens, refresh tokens, and rate-limit counters. Do not replace it with
an in-memory store on Vercel.

## 3. Create the shared company login

Set:

```dotenv
MCP_AUTH_MODE=shared-login
MCP_LOGIN_USERNAME=your-company-username
```

Generate the password hash on a trusted computer from the repository directory:

```sh
npm ci
npm run login:password
```

Enter a strong password of at least 16 characters. Copy the printed
`scrypt:...` value into `MCP_LOGIN_PASSWORD_HASH`. Store the plaintext password
only in your company password manager. Colleagues use this username and
password; they do not use a Google login.

## 4. Connect the one Google Ads account and Sheet

The server owner must supply the Google credentials. Colleagues never see the
refresh token.

Set these variables:

| Variable | Value |
| --- | --- |
| `GOOGLE_ADS_CLIENT_ID` | Google Cloud OAuth web client ID |
| `GOOGLE_ADS_CLIENT_SECRET` | Matching client secret |
| `GOOGLE_ADS_REFRESH_TOKEN` | Server refresh token |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API developer token |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Manager ID, only when required |
| `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` | The one Ads customer ID, digits only |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | ID from the Sheet URL |
| `GOOGLE_SHEETS_BUDGET_RANGE` | For example `Budget!A1:D1000` |

The Google refresh token must include both scopes:

```text
https://www.googleapis.com/auth/adwords
https://www.googleapis.com/auth/spreadsheets.readonly
```

The Google account behind that token must have access to the Sheet and the
Google Ads account. The Sheet range must contain a header row with
`Account name`, `Customer ID`, and `Ad target spend`; `Comments` is optional.
The customer ID must appear in both the Sheet and the
`GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` value.

The private Blob/CSV variables are optional legacy fallback settings. Leave
`GOOGLE_SHEETS_SPREADSHEET_ID` unset only if you intentionally want to use the
older CSV path.

## 5. Deploy and verify

Redeploy after adding or changing variables. Check these URLs in a browser:

- `/.well-known/oauth-protected-resource` returns the MCP resource and the
  authorization server.
- `/.well-known/oauth-authorization-server` returns the authorization and token
  endpoints.
- `/api/mcp` returns **401** when called without a bearer token.

The MCP URL is ready when an AI client can complete the login page and list the
worksheet accounts. Then run one known-date report and compare it with Google
Ads using the account's time zone.

## 6. Connect colleagues

Send them only:

- `https://YOUR-PROJECT.vercel.app/api/mcp`
- the shared company username
- the shared company password

Use [COLLEAGUE-CONNECTION-GUIDE.md](COLLEAGUE-CONNECTION-GUIDE.md) for the
ChatGPT and Claude clicks. Never send the Google refresh token, developer
token, Redis token, or password hash.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Login page does not appear | `MCP_AUTH_MODE`, username, password hash, and `MCP_RESOURCE_URL` |
| OAuth discovery is 503 | Redis variables or one of the shared-login variables is missing |
| Client returns to the wrong page | The client must use the exact deployed `/api/mcp` URL and support OAuth PKCE |
| `401` after connecting | The client token expired; reconnect, or check Redis availability |
| Worksheet accounts fail | Sheet ID, range, headers, access, and the refresh-token Sheets scope |
| Ads report fails | Developer token, manager ID, Ads account permission, allowlist, and Sheet customer ID |
| Browser returns `403` | Add the exact browser origin to `MCP_ALLOWED_ORIGINS`; leave it blank for server-to-server clients |

Rotate the shared password by generating a new hash and redeploying. Existing
connections become invalid when the password hash changes.
