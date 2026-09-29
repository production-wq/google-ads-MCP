# Google Ads + master worksheet MCP

An authenticated MCP service for internal use: your team connects Claude,
ChatGPT or any MCP-capable client, and asks it to read and change Google Ads
against one master Google Sheet. Next.js on Vercel, `mcp-handler`, and the
Google Ads and Sheets REST APIs.

- **Connect Google Ads and the sheet:** [SETUP.md](SETUP.md)
- **Deploy and connect clients:** [VERCEL-GUIDE.md](VERCEL-GUIDE.md)

There is no database. Users live in an environment variable, the audit trail
lives in the sheet, and confirmations are signed tokens rather than rows.

## Tools

**Read** — available to every signed-in user.

| Tool | Result |
| --- | --- |
| `whoami` | Who is signed in and whether this connection may change anything |
| `worksheet_accounts` | Accounts, target budgets and notes from the master sheet, paginated, with a source version |
| `worksheet_list_tabs` | Every tab in the sheet with its size |
| `worksheet_read_range` | Any range of the sheet in A1 notation, up to 20 000 cells |
| `google_ads_list_entities` | Campaigns, ad groups, keywords or ads with the IDs, statuses and bids the write tools need |
| `google_ads_search` | One bounded GAQL `SELECT` for an allowed account |
| `google_ads_field_metadata` | Google Ads field metadata, for composing queries |
| `worksheet_account_report` | Cost, clicks, impressions, conversions, weighted CTR, CPC and cost/conversion for explicit dates |

**Write** — only for users with the `write` role, and only on write-allowlisted
accounts.

| Tool | Result |
| --- | --- |
| `google_ads_set_campaign_budget` | Change one campaign's daily budget |
| `google_ads_set_status` | Pause or enable a campaign, ad group or ad |
| `google_ads_add_keywords` | Add up to 50 keywords to an ad group |
| `google_ads_remove_keywords` | Remove keywords by criterion ID |
| `google_ads_set_keyword_bids` | Change max CPC bids |
| `google_ads_add_negative_keywords` | Add negatives at campaign or ad group level |
| `google_ads_update_ad_copy` | Edit responsive search ad headlines, descriptions, final URLs and paths |
| `google_ads_create_campaign` | Create a search campaign with its budget, always PAUSED |
| `google_ads_create_ad_group` | Create an ad group, always PAUSED |
| `worksheet_write_range` | Overwrite a range of the sheet |
| `worksheet_append_rows` | Append rows to a tab |

Deleting campaigns, ad groups and ads is not exposed. Neither is account
structure beyond the above — no shared sets, audiences, bidding strategies or
conversion settings.

## How a change happens

Every write is two calls.

1. The AI calls the tool. The service resolves the account, builds the exact
   Google Ads operations, and sends them to Google with `validateOnly` — Google
   checks them for real and changes nothing. Back comes a preview: current
   values, new values, warnings, and a signed `confirm_token`.
2. The AI calls the same tool again with that token. **The plan is read out of
   the token, not out of the arguments**, so a second call that says something
   different still applies exactly what was previewed. The change is then written
   to the audit tab.

A confirm token lasts 10 minutes, works only for the user who previewed it and
only for the tool that issued it. Within that window it can be redeemed more than
once, so keep the window short.

`worksheet_append_rows` is the one exception: appending cannot overwrite
anything, so it applies in one call. It is still logged.

## Guardrails

- **Two allowlists.** `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` for reads,
  `GOOGLE_ADS_WRITE_CUSTOMER_IDS` for writes. Both empty by default, both fail
  closed. An account must also appear in the sheet.
- **Budget caps.** `MAX_DAILY_BUDGET` and `MAX_BUDGET_CHANGE_PERCENT` reject a
  change before Google ever sees it. Shared budgets are flagged in the preview
  with the campaigns they affect.
- **New campaigns and ad groups are created PAUSED.** They spend nothing until
  somebody enables them, which is itself a previewed, logged change.
- **50 operations per call**, so one instruction cannot rewrite an account.
- **Audit trail.** Every applied change appends a row to the audit tab:
  timestamp, user, tool, customer ID, summary, full detail and result.
- **Untrusted content stays data.** Sheet cells and account notes are labelled
  as source data, never instructions, in every tool description.

None of this replaces Google's own permissions. Give the service account the
narrowest Google Ads role that still allows what you want.

## Sign-in, without a database

Users are one environment variable:

```dotenv
MCP_USERS_JSON={"jana":{"password_hash":"scrypt$…$…","role":"write"}}
```

Create entries with `npm run user:hash -- <username> <password> write`. Only the
scrypt hash is stored. Users sign in at `/login` and get a bearer token to paste
into their AI client; tokens are signed with `SESSION_SECRET` and carry the role.
Remove a user from the variable and their tokens stop working on the next call.
Rotate `SESSION_SECRET` to sign everyone out.

Machine clients can use `MCP_API_KEYS_JSON` instead — a plain string value is
read-only, `{"ci":{"key":"…","role":"write"}}` may write. Anonymous requests fail
closed.

Hosted connectors that only speak OAuth are served by the app itself: it is a
small OAuth 2.1 authorization server with dynamic client registration, PKCE and
refresh tokens, at `/oauth/register`, `/oauth/authorize` and `/oauth/token`. A
client registers itself, the user signs in with the same username and password,
and the role decides the scopes — so Claude Desktop's Connectors screen,
claude.ai and ChatGPT all work without a second user list or an external service.
Like the confirmations, it stores nothing: client IDs, authorization codes and
refresh tokens are signed values. Set `OAUTH_ISSUER` only to hand sign-in to an
external provider instead.

## The master sheet

Set `GOOGLE_SHEETS_SPREADSHEET_ID` and the service reads the live sheet on every
call — no upload step, no redeploy. The accounts tab needs `Account name`,
`Customer ID`, `Ad target spend` and optionally `Comments`; preamble rows and
extra columns are tolerated.

Each response carries a SHA-256 version of the source and the time it was read.
Pass that version back as `expected_version` on follow-up calls and the service
refuses to mix revisions mid-report.

If `GOOGLE_SHEETS_SPREADSHEET_ID` is empty, the older private-Blob CSV path still
works: `npm run csv:upload -- "/path/to/Budget.csv"`.

## Local use

Requires Node.js 22+.

```bash
npm ci
cp .env.example .env.local   # then follow SETUP.md
npm run setup:check
npm run dev
```

Connect a client to `http://localhost:3000/api/mcp`, or open
`http://localhost:3000/login` for a token.

```bash
npm run typecheck
npm test        # 19 unit tests, synthetic data and mocked Google calls
npm run build
npm run smoke   # real MCP handshake against a running server
```

The tests cover password hashing, session and confirmation tokens, both
allowlists, budget guardrails, micros conversion, ad-copy bounds, range
validation, and that a preview sends `validateOnly` while only the confirm step
mutates. They do not prove live Google Ads authorisation — that needs an
approved developer token and a real account.

## Reporting notes

Numeric budgets in the sheet are targets, not API campaign budgets, and do not
prove a campaign is active. Cost micros are divided by 1 000 000. CTR is total
clicks / total impressions. Dates use the account time zone. Do not combine
currencies, and do not substitute Google Ads conversions for CallRail qualified
calls or forms.

References: [Vercel MCP](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel),
[Google Ads REST auth](https://developers.google.com/google-ads/api/rest/auth),
[search](https://developers.google.com/google-ads/api/rest/common/search),
[mutate](https://developers.google.com/google-ads/api/docs/mutating/overview),
[Sheets values API](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values).
