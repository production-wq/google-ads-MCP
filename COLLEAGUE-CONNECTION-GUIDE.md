# Connect the company Google Ads MCP

Use these steps when your administrator has given you the company MCP URL,
username, and password.

## ChatGPT

1. Open ChatGPT **Settings** and enable **Developer mode** if your workspace
   makes it available.
2. Open the MCP / connector area and choose **Add connector** or **Add custom
   MCP**.
3. Enter the company MCP URL exactly as provided. It should end with
   `/api/mcp`, for example:

   `https://google-ads-mcp-one.vercel.app/api/mcp`

4. Choose **Connect**. A company sign-in page opens.
5. Enter the shared company username and password, then choose **Sign in and
   connect**.
6. Enable the connection in your chat and ask: **“List the worksheet
   accounts.”**

## Claude

1. Open **Customize → Connectors → + → Add custom connector**.
2. Enter the same company MCP URL ending in `/api/mcp`.
3. Choose **Connect**, then enter the shared company username and password on
   the company sign-in page.
4. Enable the connector in your conversation and ask: **“List the worksheet
   accounts.”**

For Claude Team or Enterprise, an organization owner may need to add or allow
the connector first.

## What you should expect

- You do **not** sign in to Google and you do **not** select an Ads account.
- Everyone uses the same company Google Ads account and Google Sheet configured
  by the administrator.
- The MCP exposes read-only tools. It does not create or edit campaigns or
  write to the Sheet.
- Use the deployed HTTPS MCP URL. Do not use the GitHub repository URL or a
  localhost URL.
- Never paste a Google refresh token, developer token, or other server secret
  into ChatGPT, Claude, or the sign-in form.

If the connection fails, send the administrator the exact error and the AI app
you used. Do not send the company password or any token in a screenshot.
