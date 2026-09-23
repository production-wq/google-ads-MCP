# Connect the company Google Ads MCP to ChatGPT or Claude

This is the short guide for colleagues. The administrator must finish the
server setup first. You only need the deployed MCP URL and the shared company
login.

The MCP URL is:

`https://google-ads-mcp-one.vercel.app/api/mcp`

Use that URL exactly. The GitHub repository URL is not an MCP connection URL.

## ChatGPT

1. Open ChatGPT **Settings** and enable **Developer mode** if it is available
   for your account or workspace.
2. Open the MCP / connector area and choose **Add connector** or **Add custom
   MCP**.
3. Paste the MCP URL above and choose **Connect**.
4. On the company sign-in page, enter the shared username and password supplied
   by your administrator.
5. Enable the connection in a new chat and ask: **“List the worksheet
   accounts.”**

## Claude

1. Open **Customize → Connectors → + → Add custom connector**.
2. Paste the same MCP URL and choose **Connect**.
3. Enter the shared company username and password on the sign-in page.
4. Enable the connector in your conversation and ask: **“List the worksheet
   accounts.”**

On Claude Team or Enterprise, an organization owner may need to allow the
connector first.

## Important

- You do not sign in to Google or choose an Ads account. The administrator has
  already connected the one company Google Ads account and one company Sheet.
- The tools are read-only. They can read the configured Ads and Sheet data but
  cannot edit campaigns or write to the Sheet.
- Never enter a Google refresh token, Google developer token, or any other
  server secret into ChatGPT or Claude.
- If the connection fails, send the administrator the AI app name and exact
  error message. Do not send passwords or access tokens.

For setup of the server itself, see `VERCEL-GUIDE.md`. This page is only for
people connecting an already configured deployment.
