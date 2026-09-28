import { loadBudget } from './csv';
import { loadSheetAccounts } from './sheets';

/**
 * The master account list. A configured Google Sheet wins; the private Blob CSV
 * stays as the fallback so an existing deployment keeps working unchanged.
 */
export async function loadAccounts() {
  return process.env.GOOGLE_SHEETS_SPREADSHEET_ID ? loadSheetAccounts() : loadBudget();
}
export function sheetConfigured() { return !!process.env.GOOGLE_SHEETS_SPREADSHEET_ID; }
