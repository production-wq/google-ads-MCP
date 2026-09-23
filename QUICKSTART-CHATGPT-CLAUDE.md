# Connect this Google Ads MCP to ChatGPT or Claude

This is the short setup path for the **hosted** ChatGPT and Claude apps. Both need a deployed, HTTPS MCP server and an OAuth sign-in flow. The GitHub URL and a server running only on your laptop are not connection URLs.

## Before connecting either app

1. Deploy this repository to Vercel. Your MCP URL will look like `https://YOUR-PROJECT.vercel.app/api/mcp`.
2. In the Vercel project, configure the Google Ads client ID, client secret, refresh token, developer token, and an allowed customer ID list. Connect a private Blob store and upload the budget CSV. The customer ID must appear in both the CSV and `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS`.
3. Set `MCP_RESOURCE_URL` to the **exact** HTTPS MCP URL. Configure an external MCP-compatible OAuth provider: set `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, and `OAUTH_ALLOWED_SUBJECTS` in Vercel. The provider must issue signed JWT access tokens with the MCP URL as audience and `ads:read` scope, and support the client's authorization-code/PKCE registration and redirects. Redeploy after changing environment variables.
4. Test `https://YOUR-PROJECT.vercel.app/.well-known/oauth-protected-resource` in a browser. It should return JSON with your MCP resource URL and OAuth issuer. An unauthenticated request to `/api/mcp` should return **401**. These checks do not prove that OAuth login or Google Ads access works.

The server verifies OAuth tokens but does not provide a login page or authorization server. The Google refresh token is only for the server's connection to Google Ads; do not enter it in ChatGPT or Claude. See [VERCEL-GUIDE.md](VERCEL-GUIDE.md) for exact Vercel variables and CSV upload commands.

## ChatGPT

1. Open **Settings → Security and login** and enable **Developer mode**, if available for your account or workspace.
2. Open **Plugins**, select **+**, enter a name such as **Google Ads MCP**, and enter your deployed URL ending in `/api/mcp`.
3. Create the connection, complete the OAuth sign-in, and check that four read-only tools appear.
4. In a new conversation, enable the connection and ask: **“List my worksheet accounts.”**

[OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## Claude (web or remote connector)

1. Open **Customize → Connectors → + → Add custom connector**. On Team or Enterprise, an owner first adds the URL under **Organization settings → Connectors**.
2. Enter the same deployed `/api/mcp` URL, add the connector, and select **Connect** to complete OAuth.
3. Enable it for your conversation and ask: **“List my worksheet accounts.”**

[Claude's connection guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

If either app cannot connect, verify the HTTPS URL, OAuth provider discovery and token audience/scope first. **401** indicates missing or rejected credentials; **403** can mean a missing `ads:read` scope. If account listing works but an Ads report fails, check the Google Ads credentials, account access, CSV membership and allowlist. For a fuller local test and Claude Code instructions, see [CLIENT-SETUP.md](CLIENT-SETUP.md).
