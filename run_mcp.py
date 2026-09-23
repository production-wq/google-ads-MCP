"""Launch the official server with the project's restricted tool configuration."""
import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env', override=False)
os.environ['GOOGLE_ADS_MCP_TOOLS_CONFIG'] = str(ROOT / 'tools_config.yaml')

if bool(os.getenv('GOOGLE_ADS_MCP_OAUTH_CLIENT_ID')) != bool(os.getenv('GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET')):
    raise SystemExit('OAuth requires both client ID and client secret.')

from ads_mcp.server import run_server

if __name__ == '__main__':
    run_server()
