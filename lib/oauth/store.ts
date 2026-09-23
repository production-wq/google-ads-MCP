import { required } from './config';
export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, seconds: number): Promise<void>;
  del(key: string): Promise<void>;
  take<T>(key: string): Promise<T | null>;
  consumeRefresh<T>(key: string): Promise<{ value: T; reused: boolean } | null>;
  limit(key: string, maximum: number, seconds: number): Promise<boolean>;
}

// Durable Redis is mandatory. Never fall back to instance-local Vercel memory.
export class RedisStore implements Store {
  private async command(command: (string | number)[]) {
    const endpoint = new URL(required('UPSTASH_REDIS_REST_URL'));
    if (endpoint.protocol !== 'https:') throw new Error('Redis must use HTTPS.');
    const response = await fetch(endpoint, { method: 'POST', cache: 'no-store',
      headers: { Authorization: `Bearer ${required('UPSTASH_REDIS_REST_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('OAuth storage unavailable.');
    const data = await response.json();
    if (data.error) throw new Error('OAuth storage unavailable.');
    return data.result;
  }
  private key(key: string) { return `google-ads-oauth:v1:${key}`; }
  async get<T>(key: string): Promise<T | null> {
    const value = await this.command(['GET', this.key(key)]);
    return value === null ? null : JSON.parse(value);
  }
  async set(key: string, value: unknown, seconds: number) {
    await this.command(['SET', this.key(key), JSON.stringify(value), 'EX', Math.max(1, Math.floor(seconds))]);
  }
  async del(key: string) { await this.command(['DEL', this.key(key)]); }
  async take<T>(key: string): Promise<T | null> {
    const value = await this.command(['GETDEL', this.key(key)]);
    return value === null ? null : JSON.parse(value);
  }
  async consumeRefresh<T>(key: string): Promise<{ value: T; reused: boolean } | null> {
    // Keep a used-token tombstone for replay detection, preserving its expiry.
    const script = `local v=redis.call('GET',KEYS[1]); if not v then return nil end
local d=cjson.decode(v); if d.used then return cjson.encode({value=d,reused=true}) end
local ttl=redis.call('PTTL',KEYS[1]); d.used=true
redis.call('SET',KEYS[1],cjson.encode(d),'PX',math.max(ttl,1))
return cjson.encode({value=d,reused=false})`;
    const value = await this.command(['EVAL', script, 1, this.key(key)]);
    return value === null ? null : JSON.parse(value);
  }
  async limit(key: string, maximum: number, seconds: number) {
    const script = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`;
    return Number(await this.command(['EVAL', script, 1, this.key(`rate:${key}`), seconds])) <= maximum;
  }
}
