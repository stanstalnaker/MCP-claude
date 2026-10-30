import { createHash, createHmac } from "node:crypto";
import { UpstreamError } from "./hubid.js";

// Ven payments interchange (hub-culture/payments-interchange). It trusts only calls signed
// with Hub's shared secret, carrying the buyer's HubID user id. See src/auth.rs there:
//   canonical = timestamp \n METHOD \n path?query \n user id \n role \n hex(sha256(body))
//   X-Pay-Signature = hex(hmac_sha256(secret, canonical))
export function signPaymentsRequest(
  secret: string,
  timestamp: number,
  method: string,
  pathAndQuery: string,
  userId: number,
  role: string,
  body: string,
): string {
  const canonical = [
    timestamp,
    method.toUpperCase(),
    pathAndQuery,
    userId,
    role,
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export class PaymentsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Always signs as role `buyer`: agents never get the interchange's admin API. */
  async request<T>(userId: number, method: "GET" | "POST", pathAndQuery: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const res = await this.fetchImpl(this.baseUrl + pathAndQuery, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Pay-Timestamp": String(ts),
        "X-Pay-User": String(userId),
        "X-Pay-Role": "buyer",
        "X-Pay-Signature": signPaymentsRequest(this.secret, ts, method, pathAndQuery, userId, "buyer", raw),
      },
      body: raw || undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) {
      const message = (json as { error?: string; message?: string } | null)?.error ?? (json as { message?: string } | null)?.message;
      throw new UpstreamError(message ?? `Payments interchange error (HTTP ${res.status})`, res.status, "payments");
    }
    return json as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}
