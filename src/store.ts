import { createClient, type RedisClientType } from "redis";

// Key-value storage for OAuth clients, pending sign-ins, codes and tokens.
// Redis in production so sign-ins survive restarts and work across instances;
// memory for local development and tests.
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Read and delete in one step, so a one-time value (code, pending sign-in) can be used only once. */
  take<T>(key: string): Promise<T | undefined>;
}

export class MemoryStore implements Store {
  private items = new Map<string, { value: string; expiresAt?: number }>();

  async get<T>(key: string): Promise<T | undefined> {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    return JSON.parse(item.value) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.items.set(key, {
      value: JSON.stringify(value),
      expiresAt: ttlSeconds === undefined ? undefined : Date.now() + ttlSeconds * 1000,
    });
  }

  async del(key: string): Promise<void> {
    this.items.delete(key);
  }

  async take<T>(key: string): Promise<T | undefined> {
    const value = await this.get<T>(key);
    this.items.delete(key);
    return value;
  }
}

export class RedisStore implements Store {
  private constructor(private client: RedisClientType) {}

  static async connect(url: string): Promise<RedisStore> {
    const client: RedisClientType = createClient({ url });
    client.on("error", (err) => console.error("redis error:", err.message));
    await client.connect();
    return new RedisStore(client);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(`hubmcp:${key}`);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const options = ttlSeconds === undefined ? undefined : { EX: Math.max(1, Math.ceil(ttlSeconds)) };
    await this.client.set(`hubmcp:${key}`, JSON.stringify(value), options);
  }

  async del(key: string): Promise<void> {
    await this.client.del(`hubmcp:${key}`);
  }

  async take<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.getDel(`hubmcp:${key}`);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }
}
