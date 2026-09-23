# Publish and connect the MCP

For a local walkthrough and exact client commands, see [CLIENT-SETUP.md](CLIENT-SETUP.md).

## 1. Publish the code

Use your Git repository (public source code is fine; credentials and client data
must remain private). In Vercel, select
**Add New → Project**, import the repository, choose **Next.js** and Node.js 22+,
then deploy with the default build settings. Secrets, CSVs, `.venv` and `upstream`
are excluded from Git and deployment. Your endpoint will be:

`https://YOUR-PROJECT.vercel.app/api/mcp`

Alternatively run `npx vercel` from this folder, configure the project, and use
`npx vercel --prod` for production. Complete login/account setup yourself.

## 2. Configure the data

Create/connect a **private Blob store** in the Vercel project's Storage tab.
Add the settings from `.env.example` under Settings → Environment Variables:

- `MCP_RESOURCE_URL`: your full production MCP URL.
- `BLOB_READ_WRITE_TOKEN`: private store credential, also used locally for uploads.
  Connected-store OIDC authentication is an alternative on Vercel itself.
- `CSV_BLOB_PATH`: `worksheets/budget.csv`.
- Google Ads client ID, client secret, refresh token, developer token and manager
  ID when applicable. The refresh token must have the `adwords` scope and belong
  to an authorized user, preferably with read-only Google Ads permissions.
- `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS`: approved comma-separated customer IDs. New
  accounts in the CSV do not automatically expand live Ads permissions.

Keep secrets out of `NEXT_PUBLIC_` variables. Do not set `CSV_LOCAL_PATH` on Vercel.
Redeploy after changing environment variables.

## 3. Set up sign-in

For hosted ChatGPT/Claude connectors, configure an external MCP-capable OAuth
provider, such as **Auth0 Auth for MCP**. This app verifies tokens, not issues them.

1. Create an API/resource with its audience/identifier exactly equal to
   `MCP_RESOURCE_URL`; define the permission `ads:read`.
2. Enable the provider's MCP onboarding, authorization-code flow and PKCE. Support
   CIMD and/or dynamic client registration as required by your clients. Follow
   the provider's current MCP guide and restrict login to intended users.
3. Set `OAUTH_ISSUER` to its exact issuer and `OAUTH_JWKS_URL` to its HTTPS public
   signing-key endpoint. Use actual provider metadata, including trailing slashes.
4. Set `OAUTH_ALLOWED_SUBJECTS` to approved users' `sub` IDs, comma separated.
   Empty rejects everyone. Tokens must include the `ads:read` scope.
5. Redeploy. `/.well-known/oauth-protected-resource` should show the issuer and
   resource; unauthenticated `/api/mcp` requests must return 401.

With Auth0, configure MCP resource/audience mapping (and its Default Audience when
required by that integration), so the token audience matches the MCP resource,
not userinfo. Real provider setup and a client login are required to verify OAuth.

For clients supporting custom Authorization headers, an independent API key can
be used instead. Generate one key per client with `openssl rand -hex 32` and set
`MCP_API_KEYS_JSON` to an object such as:

`{"jana-laptop":"REPLACE_WITH_GENERATED_KEY","other-client":"ANOTHER_KEY"}`

Static keys do not replace OAuth for hosted clients that cannot accept headers.

## 4. Upload each new CSV

Create `.env.local` on your computer from `.env.example`, set the private Blob
credential and `CSV_BLOB_PATH`, then run:

```sh
npm ci
npm run csv:upload -- "/path/to/PPC Master Report - Budget.csv"
```

Repeat after each CSV export. This validates and replaces the same private object.
All connected clients read the new version on their next call. No redeploy needed.
Changing the local file alone does not update the server; run the upload command
or invoke it from your existing export workflow.

## 5. Connect any supported AI client

| Client | How |
| --- | --- |
| ChatGPT | Enable developer mode if available in your account/workspace. Current documentation puts it under Settings → Security and login. Add an MCP connection under Plugins using the production URL; complete OAuth. |
| Claude remote connectors | Customize → Connectors → + → Add custom connector, enter the production URL, then complete OAuth. |
| Other clients, including Chinese AI applications | Use their remote MCP / Streamable HTTP option with OAuth or a Bearer header. Support depends on the application and network, not the model name. |
| Stdio-only desktop clients | Use an MCP bridge such as `mcp-remote` pointing at the same URL. |

Claude Code HTTP configuration (other clients may use a different wrapper):

```json
{
  "mcpServers": {
    "google-ads-worksheet": {
      "type": "http",
      "url": "https://YOUR-PROJECT.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_CLIENT_KEY" }
    }
  }
}
```

One deployment can serve multiple authorized AI accounts for the same business.
For an unrelated organization, use separate deployment, storage and credentials.

Set `MCP_TEST_URL` in `.env.local` to the deployed endpoint and run `npm run smoke`
with a configured client key. Then query one real authorized account and compare
with Google Ads for identical dates/time zone before considering integration done.

401: invalid/missing token. 403: insufficient scope or disallowed browser Origin.
OAuth metadata 503: issuer/resource not configured. If Vercel Deployment Protection
returns a login page, configure machine access for the intended deployment/client
while retaining this app's mandatory MCP authentication.

Official references: [Vercel MCP](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel),
[private storage](https://vercel.com/docs/vercel-blob/private-storage),
[Auth0 MCP](https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/),
[ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[Claude](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
