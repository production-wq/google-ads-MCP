export function GET() {
  return Response.json({ name: 'Google Ads Worksheet MCP', endpoint: '/api/mcp', sign_in: '/login',
    transport: 'Streamable HTTP', authentication: 'Required',
    google_ads_access: 'Read, plus writes for write-role users on allowlisted accounts',
    writes: 'Every change is previewed and must be confirmed with a signed token, then logged to the sheet' });
}
