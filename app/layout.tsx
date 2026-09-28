export const metadata = { title: 'Google Ads Worksheet MCP', description: 'Internal MCP access' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        background: '#0f1115', color: '#e8eaed' }}>{children}</body>
    </html>
  );
}
