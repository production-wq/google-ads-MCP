"""Verify the official server's actual MCP tool surface without account access."""
import asyncio
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ['GOOGLE_ADS_MCP_TOOLS_CONFIG'] = str(ROOT / 'tools_config.yaml')

from fastmcp import Client
from ads_mcp.server import mcp

EXPECTED = {'customers_list_accessible_customers', 'search_search',
            'metadata_get_resource_metadata'}

async def main():
    async with Client(mcp) as client:
        tools = await client.list_tools()
        names = {tool.name for tool in tools}
        assert names == EXPECTED, f'Unexpected tool surface: {names}'
        assert all(t.annotations and t.annotations.read_only_hint for t in tools)
        for name in sorted(names):
            print(f'PASS read-only tool: {name}')
        print('Local MCP verification passed. Live Ads access and ChatGPT connection remain unverified.')

if __name__ == '__main__':
    asyncio.run(main())
