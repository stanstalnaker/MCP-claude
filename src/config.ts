// All configuration comes from the environment. See .env.example for what each value means.

export type Config = {
  publicUrl: URL;
  port: number;
  hubid: {
    url: string;
    clientId: string;
    publicKey: string;
    privateKey: string;
  };
  venRatesUrl: string;
  payments?: { url: string; sharedSecret: string };
  zeke?: { url: string; systemToken: string };
  redisUrl?: string;
  tokenEncryptionKey: Buffer;
  maxVenPerTransfer: number;
  allowedRedirectUris: string[];
  defaultScopes: Scope[];
};

export const SCOPES = {
  read: "Read your Hub Culture profile, friends, hubs, events, messages and Ven history",
  write: "Post, message, send friend requests and create events as you",
  "ven:transfer": "Send Ven from your wallet",
  "ven:purchase": "Create Ven purchase orders (you still pay on the checkout page)",
  zeke: "Ask Zeke on your behalf",
} as const;
export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

// Claude's hosted callbacks plus loopback redirects for local clients (Claude Code, MCP Inspector).
const DEFAULT_REDIRECTS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "http://localhost:*",
  "http://127.0.0.1:*",
];

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function list(value: string | undefined): string[] | undefined {
  const items = value?.split(/[\s,]+/).filter(Boolean);
  return items?.length ? items : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const key = Buffer.from(required(env, "TOKEN_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");

  const defaultScopes = (list(env.DEFAULT_SCOPES) ?? ALL_SCOPES) as Scope[];
  for (const scope of defaultScopes) {
    if (!ALL_SCOPES.includes(scope)) throw new Error(`Unknown scope in DEFAULT_SCOPES: ${scope}`);
  }

  return {
    publicUrl: new URL(required(env, "PUBLIC_URL")),
    port: Number(env.PORT ?? 8080),
    hubid: {
      url: (env.HUBID_URL ?? "https://id.hubculture.com").replace(/\/$/, ""),
      clientId: required(env, "HUBID_CLIENT_ID"),
      publicKey: required(env, "HUBID_PUBLIC_KEY"),
      privateKey: required(env, "HUBID_PRIVATE_KEY"),
    },
    venRatesUrl: (env.VEN_RATES_URL ?? "https://apilaravel.ven.vc").replace(/\/$/, ""),
    payments:
      env.PAYMENTS_URL && env.PAYMENTS_SHARED_SECRET
        ? { url: env.PAYMENTS_URL.replace(/\/$/, ""), sharedSecret: env.PAYMENTS_SHARED_SECRET }
        : undefined,
    zeke:
      env.ZEKE_URL && env.ZEKE_SYSTEM_TOKEN
        ? { url: env.ZEKE_URL.replace(/\/$/, ""), systemToken: env.ZEKE_SYSTEM_TOKEN }
        : undefined,
    redisUrl: env.REDIS_URL || undefined,
    tokenEncryptionKey: key,
    maxVenPerTransfer: Number(env.MAX_VEN_PER_TRANSFER ?? 1000),
    allowedRedirectUris: list(env.ALLOWED_REDIRECT_URIS) ?? DEFAULT_REDIRECTS,
    defaultScopes,
  };
}
