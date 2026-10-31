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
  /** Member mandate, enforced by the connector. Agent mandates are set per agent in HubID (Mandala custodian policy). */
  venSendPerTx: number;
  venSendPerDay: number;
  allowedRedirectUris: string[];
  defaultScopes: Scope[];
  disabledTools: string[];
  rateLimitPerMinute: { read: number; write: number };
  agentGrantDays: number;
};

// Scope names follow the PRD ("Hub Culture Connector for Claude"), plus messages:* and ven:purchase.
export const SCOPES = {
  "profile:read": "Read your HubID profile, other members' public profiles and your friends",
  "hubid:write": "Update your status and send or answer friend requests",
  "hubs:read": "Read hubs, their discussions, news, events and pavilions",
  "hubs:write": "Post discussions and create events as you",
  "messages:read": "Read your private messages and alerts",
  "messages:send": "Send private messages as you",
  "ven:read": "See Ven prices, your balance and transaction history",
  "ven:request": "Ask other members for Ven",
  "ven:send": "Send Ven, within your mandate's caps",
  "ven:purchase": "Start Ven purchases (you still pay on the checkout page)",
  "zeke:ask": "Ask Zeke on your behalf",
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
    venSendPerTx: Number(env.VEN_SEND_PER_TX ?? 100),
    venSendPerDay: Number(env.VEN_SEND_PER_DAY ?? 500),
    allowedRedirectUris: list(env.ALLOWED_REDIRECT_URIS) ?? DEFAULT_REDIRECTS,
    defaultScopes,
    disabledTools: list(env.DISABLED_TOOLS) ?? [],
    rateLimitPerMinute: {
      read: Number(env.RATE_LIMIT_READ_PER_MINUTE ?? 60),
      write: Number(env.RATE_LIMIT_WRITE_PER_MINUTE ?? 10),
    },
    agentGrantDays: Number(env.AGENT_GRANT_DAYS ?? 90),
  };
}
