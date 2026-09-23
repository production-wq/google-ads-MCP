import { readFile } from 'node:fs/promises';
import { put } from '@vercel/blob';
import { parseBudget } from '../lib/csv';

const path = process.argv[2];
if (!path) throw new Error('Usage: npm run csv:upload -- /path/to/Budget.csv');
const text = await readFile(path, 'utf8');
const data = parseBudget(text); // Invalid files never replace the working CSV.
await put(process.env.CSV_BLOB_PATH || 'worksheets/budget.csv', text, {
  access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/csv',
});
console.log(JSON.stringify({ uploaded: true, accounts: data.accounts.length, csv_version: data.version }));
