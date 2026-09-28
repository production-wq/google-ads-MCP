/**
 * An error whose message is safe to return to the AI client. Everything else is
 * replaced with a generic message so upstream response bodies, URLs, tokens and
 * file contents never leak through a tool result.
 */
export class SafeError extends Error {
  constructor(message: string) { super(message); this.name = 'SafeError'; }
}
export function safe(message: string): never { throw new SafeError(message); }
