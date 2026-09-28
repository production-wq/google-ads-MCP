# Connect Google Ads and the master Google Sheet

Do these once. Steps 1–3 need your Google logins, so they are yours to click
through; everything after that is a command. Budget about 30 minutes, plus
Google's wait for a developer token.

At the end, `npm run setup:check` proves the whole chain works.

---

## 1. Google Cloud project and OAuth client

1. At [console.cloud.google.com](https://console.cloud.google.com), create a
   project (or pick an existing one) for this service.
2. **APIs & Services → Library**: enable **Google Ads API** and **Google Sheets API**.
   Both are required — one refresh token will carry both.
3. **APIs & Services → OAuth consent screen**: choose **Internal** if your
   company uses Google Workspace, otherwise **External** and add yourself as a
   test user. Add these two scopes:
   - `https://www.googleapis.com/auth/adwords`
   - `https://www.googleapis.com/auth/spreadsheets`
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Desktop app**. Keep the client ID and client secret.

## 2. Google Ads developer token

1. Sign in to the **manager (MCC) account** that sits above your client accounts.
2. **Tools → Setup → API Center**, apply for a developer token.
3. Note the **manager account ID** (the 10-digit number, top right).

**This step gates everything on the Google Ads side.** A new token has
**Test account access**, which only reaches Google Ads *test* accounts. Live
accounts fail with one of:

- `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` — the Cloud project behind your
  OAuth client has not been approved for production use
- `DEVELOPER_TOKEN_NOT_APPROVED` — the token itself is still test-only

Both are fixed the same way: in API Center, **apply for Basic access** and name
the Cloud project that owns your OAuth client. Google usually replies within a
few business days. `npm run setup:check` detects this and says so in one line
instead of failing per account.

Everything else — the sheet, logins, tool discovery, previews, the audit log —
works while you wait.

## 3. Which Google user should this be?

The refresh token you mint next acts as one Google user. That user needs:

- access to the Google Ads accounts this MCP will touch, and
- **edit** access to the master Google Sheet.

Use a dedicated service user if you have one. Give it the narrowest Google Ads
role that still allows the changes you want: **Read only** if you are staying on
phase 1, **Standard** for phase 2 writes. The MCP's own allowlists and
guardrails sit on top of whatever Google grants, but they cannot exceed it.

## 4. Mint the refresh token

```bash
cp .env.example .env.local
```

Put the client ID and secret in `.env.local`, then:

```bash
npm run google:token
```

It prints a URL and waits 15 minutes (override with `OAUTH_WAIT_MINUTES`).
Open the URL as the user from step 3 and approve **both** boxes, Ads and Sheets.
The refresh token is written straight into `.env.local` — it is never printed, so
it cannot end up in a screenshot or a shell history. The script confirms which
scopes Google actually granted and warns if either is missing.

Run `npm run google:token -- --print` when you need the value itself, for example
to paste into Vercel.

Copy the URL fresh each time rather than reusing one from browser history. Each
run generates a new one-time `state`; an older link is ignored with a message in
the browser, and the script keeps waiting for the current one.

If no refresh token comes back at all, revoke the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
and run it again.

## 5. Point it at the master sheet

Open the sheet and copy the ID out of the URL:

`docs.google.com/spreadsheets/d/`**`1AbC…xYz`**`/edit`

```dotenv
GOOGLE_SHEETS_SPREADSHEET_ID=1AbC…xYz
SHEETS_ACCOUNTS_TAB=Budget
SHEETS_AUDIT_TAB=MCP Audit Log
```

`SHEETS_ACCOUNTS_TAB` names the tab holding the account list. Column headers
are matched case-insensitively against a set of known spellings, so tabs can
differ and still work:

| Field | Accepted headers |
| --- | --- |
| Account name | `Account name`, `Account Name` |
| Customer ID | `Customer ID`, `CID` |
| Budget/target | `Ad target spend`, `PPC Target (Zoho)`, `Monthly Budget`, `Target spend`, `Google Ads Budget (calc)` |
| Notes | `Comments`, `Notes`, `Budget Notes` |
| Status | `PPC Status`, `Zoho Status`, `Status` |

Rows above the header and extra columns are fine. Add a new spelling to
`COLUMNS` in `lib/csv.ts` if a tab uses one that is not listed.

Pick the tab with the **fullest account list**, because an account must appear in
this tab *and* in the read allowlist before the AI can query it. Other tabs stay
fully readable through `worksheet_read_range`. Repeated customer IDs and rows
whose ID will not parse are reported in the tool response rather than failing the
whole read.

Then **share the sheet with the step-3 user as an Editor**. Viewer access is
enough to read, but the audit log and every worksheet write need Editor.

The audit tab is created for you by `npm run setup:check`.

## 6. Decide what the AI may touch

```dotenv
# Accounts the AI may read. Empty denies every Ads query.
GOOGLE_ADS_ALLOWED_CUSTOMER_IDS=1234567890,2345678901
# Accounts the AI may CHANGE. Empty denies every write.
GOOGLE_ADS_WRITE_CUSTOMER_IDS=1234567890
GOOGLE_ADS_LOGIN_CUSTOMER_ID=<your manager account ID>

MAX_DAILY_BUDGET=1000
MAX_BUDGET_CHANGE_PERCENT=50
```

Start with one account in `GOOGLE_ADS_WRITE_CUSTOMER_IDS`, ideally a low-spend
one, and widen it once you trust the flow. An account must be in the sheet **and**
the read allowlist **and** the write allowlist before anything can change it.

## 7. Create the users

No database. Users live in one environment variable.

```bash
openssl rand -hex 32          # put this in SESSION_SECRET — see note below
npm run user:hash -- jana 'a long passphrase here' write
npm run user:hash -- tom 'another long passphrase' read
```

Each command prints a JSON fragment. Merge them into one object:

```dotenv
SESSION_SECRET=<the openssl output>
MCP_USERS_JSON={"jana":{"password_hash":"scrypt$…$…","role":"write"},"tom":{"password_hash":"scrypt$…$…","role":"read"}}
```

- `write` may change Google Ads and the sheet. `read` may only read.
- Passwords are never stored, only scrypt hashes.
- To remove someone, delete their entry and redeploy. Their existing tokens stop
  working immediately.
- Rotating `SESSION_SECRET` signs everyone out at once.

## 8. Verify

```bash
npm run setup:check
```

It reports, line by line: env vars present, users loaded, refresh token
exchangeable, which Google Ads accounts actually answer, whether the write
allowlist is a subset of the read allowlist, how many accounts parsed out of the
sheet, and whether the audit tab exists — creating it with its header if not.

Fix every `FAIL` before you connect an AI client.

## 9. Deploy and hand out logins

Copy the same variables into Vercel (see [VERCEL-GUIDE.md](VERCEL-GUIDE.md)),
redeploy, then send each person to:

`https://YOUR-PROJECT.vercel.app/login`

They sign in with their username and password and get a token plus a ready-made
client configuration block. That token is what they paste into Claude, ChatGPT
or any other MCP-capable client.

---

## What I could not do for you

- Sign in to Google, approve the consent screen, or apply for the developer
  token. Those need your credentials.
- Choose which accounts may be changed, or set the budget caps. Those are
  business decisions; step 6 is where you make them.
- Prove a live write works. That needs an approved developer token and a real
  account, and the first one should be watched by a human.
