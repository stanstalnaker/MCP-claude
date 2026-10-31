// HubID API (id.hubculture.com). User calls send the app's Private-Key plus the user's JWT;
// login and token refresh use the Public-Key. Most responses use the envelope
// {status: "success" | "error", errors, data, code}; a few return bare JSON.

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly service: string,
  ) {
    super(message);
  }
}

export type HubRequest = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  jwt?: string;
  key?: "private" | "public" | "none";
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

export type HubUser = {
  id: number;
  email?: string;
  first?: string;
  last?: string;
  name?: string;
  [key: string]: unknown;
};

export class HubIdClient {
  constructor(
    private readonly baseUrl: string,
    private readonly keys: { publicKey: string; privateKey: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T = unknown>(path: string, req: HubRequest = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
    const key = req.key ?? "private";
    if (key === "private") headers["Private-Key"] = this.keys.privateKey;
    else if (key === "public") headers["Public-Key"] = this.keys.publicKey;
    if (req.jwt) headers.Authorization = `Bearer ${req.jwt}`;
    if (req.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.fetchImpl(url, {
      method: req.method ?? "GET",
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new UpstreamError(`HubID returned a non-JSON response (HTTP ${res.status})`, res.status, "hubid");
    }

    if (isEnvelope(json)) {
      if (json.status !== "success" || !res.ok) {
        throw new UpstreamError(describeErrors(json.errors) || `HubID error (HTTP ${res.status})`, res.status, "hubid");
      }
      return json.data as T;
    }
    if (!res.ok) {
      // e.g. {"error":"token_expired"} from the JWT middleware, sent without the envelope
      const detail = (json as { error?: string } | null)?.error;
      throw new UpstreamError(detail ? `HubID: ${detail}` : `HubID error (HTTP ${res.status})`, res.status, "hubid");
    }
    return json as T;
  }

  getMe(jwt: string): Promise<HubUser> {
    return this.request<HubUser>("/user", { jwt });
  }

  /** POST /mandala/key/token: an agent's long-lived key for a fresh JWT. The key is the credential; no password. */
  async exchangeAgentKey(agentKey: string): Promise<{ token: string; user_id: number }> {
    const data = await this.request<{ token: string; user_id: number }>("/mandala/key/token", {
      method: "POST",
      key: "none",
      body: { key: agentKey },
    });
    if (!data?.token) throw new UpstreamError("HubID did not return an agent token", 502, "hubid");
    return data;
  }

  /** PUT /token: a new 24h JWT, allowed until 14 days after the original login. */
  async refresh(jwt: string): Promise<string> {
    const data = await this.request<{ token: string }>("/token", { method: "PUT", jwt, key: "public" });
    if (!data?.token) throw new UpstreamError("HubID did not return a refreshed token", 502, "hubid");
    return data.token;
  }
}

function isEnvelope(json: unknown): json is { status: string; errors?: unknown; data?: unknown } {
  return typeof json === "object" && json !== null && "status" in json && ("data" in json || "errors" in json);
}

function describeErrors(errors: unknown): string {
  if (!errors) return "";
  if (typeof errors === "string") return errors;
  if (Array.isArray(errors)) return errors.map(describeErrors).filter(Boolean).join("; ");
  if (typeof errors === "object") {
    return Object.entries(errors as Record<string, unknown>)
      .map(([field, value]) => `${field}: ${describeErrors(value)}`)
      .join("; ");
  }
  return String(errors);
}
