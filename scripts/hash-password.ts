import { hashPassword } from '../lib/auth';

const [username, password, role = 'read'] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: npm run user:hash -- <username> <password> [read|write]');
  process.exit(1);
}
if (role !== 'read' && role !== 'write') {
  console.error('Role must be "read" or "write".');
  process.exit(1);
}
const entry = { [username]: { password_hash: await hashPassword(password), role } };
console.log('\nAdd this user to MCP_USERS_JSON (merge with any existing users):\n');
console.log(JSON.stringify(entry));
console.log('\nFull example for one read user and one write user:');
console.log(JSON.stringify({ ...entry, viewer: { password_hash: 'scrypt$...$...', role: 'read' } }));
console.log('\nThe password itself is never stored. Give it to the user over a secure channel.\n');
