# Deploy and connect the MCP

Do [SETUP.md](SETUP.md) first — it produces the Google credentials, the sheet ID
and the user list this guide deploys.

## 1. Publish the code

Push this folder to your own **private** Git repository. In Vercel choose
**Add New → Project**, import it, framework **Next.js**, Node.js 22+, deploy with
the defaults. Secrets, CSVs, `.venv` and `upstream/` are excluded from Git and
from the deployment. Your endpoint will be:

`https://YOUR-PROJECT.vercel.app/api/mcp`

Or run `npx vercel` from this folder and `npx vercel --prod` for production.

## 2. Environment variables

Settings → Environment Variables. Copy the values from your working `.env.local`,
with two changes: set `MCP_RESOURCE_URL` to the real production URL, and leave
`CSV_LOCAL_PATH` unset.

Required:

| Variable | Value |
| --- | --- |
| `MCP_RESOURCE_URL` | `https://YOUR-PROJECT.vercel.app/api/mcp` |
| `SESSION_SECRET` | `openssl rand -hex 32`. Signs logins and confirmations |
| `MCP_USERS_JSON` | The merged user object from `npm run user:hash` |
| `GOOGLE_ADS_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` / `_DEVELOPER_TOKEN` | From SETUP.md |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Your manager account ID |
| `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` | Accounts the AI may read |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | The master sheet |

Optional but recommended:

| Variable | Value |
| --- | --- |
| `GOOGLE_ADS_WRITE_CUSTOMER_IDS` | Accounts the AI may change. Empty = no writes |
| `MAX_DAILY_BUDGET`, `MAX_BUDGET_CHANGE_PERCENT` | Budget guardrails |
| `SHEETS_ACCOUNTS_TAB`, `SHEETS_AUDIT_TAB` | Tab names, if not `Budget` / `MCP Audit Log` |
| `SESSION_TTL_HOURS`, `CONFIRM_TTL_SECONDS` | Token lifetimes |
| `MCP_API_KEYS_JSON` | Machine clients |
| `MCP_ALLOWED_ORIGINS` | Only if a browser-based client must call the endpoint |

Never prefix a secret with `NEXT_PUBLIC_`. Redeploy after changing variables —
Vercel does not apply them to the running deployment.

Only set `BLOB_READ_WRITE_TOKEN` and `CSV_BLOB_PATH` if you are staying on the
CSV path instead of the sheet. That needs a **private** Blob store in the
Storage tab.

## 3. Check the deployment

```bash
# from your machine, with .env.local pointing at production values
npm run setup:check
```

Then, in a browser, open `https://YOUR-PROJECT.vercel.app/login`, sign in as a
test user, and copy the token. Verify the endpoint itself:

```bash
MCP_TEST_URL=https://YOUR-PROJECT.vercel.app/api/mcp MCP_TEST_TOKEN=<token> npm run smoke
```

That asserts anonymous requests get 401, the handshake works, all 19 tools are
discovered with the right read/write annotations, and a read-only token cannot
reach a write tool.

## 4. Connect the AI clients

Each person signs in at `/login` and gets their token plus a config block.

| Client | How |
| --- | --- |
| Claude | Settings → Connectors → add a custom connector with the production URL. For header auth, use a client that accepts an `Authorization` header, or configure OAuth as below |
| ChatGPT | Enable developer mode if your workspace has it, then add an MCP connection with the production URL |
| Header-capable desktop clients | Paste the config block from `/login` |
| Stdio-only clients | Bridge with `mcp-remote` pointing at the same URL |

```json
{
  "mcpServers": {
    "google-ads-worksheet": {
      "url": "https://YOUR-PROJECT.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN_FROM_LOGIN" }
    }
  }
}
```

Hosted connectors cannot send a static header; they use OAuth. This app is its
own OAuth 2.1 authorization server, so they work with no extra service: paste the
production URL into the connector, and the client registers itself, opens this
app's own sign-in page, and the user enters the same username and password.
Roles carry across — a `read` user gets `ads:read`, a `write` user also gets
`ads:write` — so there is no second user list to maintain.

Nothing is stored for this. Registered clients, authorization codes and refresh
tokens are all signed, expiring values verified with `SESSION_SECRET`. Two
consequences worth knowing: rotating `SESSION_SECRET` invalidates every
registration and token at once, and an authorization code cannot be marked used,
so it is protected by a 60-second lifetime and PKCE rather than single use.

To delegate sign-in to an external provider instead (Auth0 and similar), set
`OAUTH_ISSUER`, `OAUTH_JWKS_URL` and `OAUTH_ALLOWED_SUBJECTS`; the built-in
server then steps aside. That means maintaining users in both places, so prefer
the built-in one unless you need SSO.

## 5. Day-to-day

- **New person:** `npm run user:hash`, merge into `MCP_USERS_JSON`, redeploy.
- **Remove a person:** delete their entry, redeploy. Their tokens die immediately.
- **New account to read:** add it to the sheet and to `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS`.
- **Allow changes to an account:** add it to `GOOGLE_ADS_WRITE_CUSTOMER_IDS`.
- **Review what the AI did:** read the audit tab in the sheet.
- **Sheet edits:** picked up on the next call. No redeploy, no upload.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| 401 | Missing, expired or revoked token |
| 403 | Read-only token on a write tool, `ads:write` missing, or a disallowed browser Origin |
| `DEVELOPER_TOKEN_NOT_APPROVED` | Google has not granted Basic access yet; only test accounts work |
| `No account is write-enabled` | `GOOGLE_ADS_WRITE_CUSTOMER_IDS` is empty |
| `Account not in deployment allowlist` | Missing from `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` |
| `Account not in current worksheet` | Missing from the accounts tab |
| Sheets 403 | The refresh-token user is not an Editor on the sheet, or the token lacks the spreadsheets scope |
| Confirmation token invalid | Older than `CONFIRM_TTL_SECONDS`, a different user, or `SESSION_SECRET` was rotated |
| A Vercel login page instead of MCP | Deployment Protection is on; configure machine access for the intended clients |

Official references: [Vercel MCP](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel),
[Auth0 MCP](https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/),
[ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[Claude](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
