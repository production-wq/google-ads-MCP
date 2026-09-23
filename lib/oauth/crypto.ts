import { createHash, randomBytes, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const random = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
export function equal(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function hashPassword(password: string) {
  if (password.length < 16 || password.length > 256) throw new Error('Use a shared password between 16 and 256 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function checkPassword(password: string, stored: string) {
  if (!/^scrypt:[a-f\d]{32}:[a-f\d]{128}$/i.test(stored) || password.length > 256) return false;
  const [, salt, expected] = stored.split(':');
  const key = await scrypt(password, salt, 64) as Buffer;
  return equal(key.toString('hex'), expected);
}
