import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { hashPassword } from '../lib/oauth/crypto';
let password: string;
if (process.stdin.isTTY) {
  // Hide terminal echo and never put the password in shell arguments/history.
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write('Shared company password (16+ characters; input hidden): ');
  password = await reader.question('');
  process.stderr.write('\nConfirm password: ');
  const confirmation = await reader.question('');
  reader.close(); process.stderr.write('\n');
  if (confirmation !== password) throw new Error('Passwords do not match.');
} else {
  let value = '';
  for await (const chunk of process.stdin) { value += chunk; if (value.length > 1024) throw new Error('Input too long.'); }
  password = value.replace(/\r?\n$/, '');
}
console.log(await hashPassword(password));
