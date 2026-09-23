export function GET() {
  return Response.json({ name: 'Google Ads Worksheet MCP', endpoint: '/api/mcp',
    transport: 'Streamable HTTP', authentication: 'Required', google_ads_access: 'Read only' });
}
