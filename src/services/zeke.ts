import { UpstreamError } from "./hubid.js";

// Zeke (hub-culture/zeke-ai-server). POST /chat takes the system bearer token and streams SSE
// lines `data: {...}`. Like src/channels/zeke_client.py there, the answer is the last non-tool
// `node_complete`.
//
// Zeke answers with the caller's context (identity, memory, friends) whenever it safely can:
// the caller's HubID JWT goes in data.hub_auth together with data.read_only, which stops Zeke's
// own send_ven tool, so Ven moves only through this connector's mandate-checked tools. A Zeke
// that doesn't advertise "read_only" in GET /health could send Ven with that token, so it gets
// no token and answers from Hub Culture's public knowledge instead.

const CAPABILITY_TTL_MS = 5 * 60_000;

// VSSToolNode in zekeai/agents/nodes/vss_factories/enums/e_vss_tool.py
const TOOL_NODES = new Set([
  "vss_questions_tool_node",
  "vss_docs_tool_node",
  "vss_news_tool_node",
  "vss_events_tool_node",
  "vss_videos_tool_node",
  "vss_router_tool_node",
  "personal_tool_node",
  "generic_tool_node",
]);

export class ZekeClient {
  private readOnly?: { value: boolean; checkedAt: number };

  constructor(
    private readonly baseUrl: string,
    private readonly systemToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Whether this Zeke honours data.read_only. Checked at most every 5 minutes; any doubt means no. */
  async supportsReadOnly(): Promise<boolean> {
    if (this.readOnly && Date.now() - this.readOnly.checkedAt < CAPABILITY_TTL_MS) return this.readOnly.value;
    let value = false;
    try {
      // /health answers 503 when a check fails but still lists capabilities, so read the body either way.
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      const body = (await res.json()) as { capabilities?: unknown };
      value = Array.isArray(body.capabilities) && body.capabilities.includes("read_only");
    } catch {
      value = false;
    }
    this.readOnly = { value, checkedAt: Date.now() };
    return value;
  }

  async ask(
    message: string,
    opts: { hubJwt?: () => Promise<string>; threadId?: string } = {},
  ): Promise<{ answer: string; threadId?: string; withCallerContext: boolean }> {
    const withCallerContext = Boolean(opts.hubJwt) && (await this.supportsReadOnly());
    const data = withCallerContext
      ? { channel: "claude_connector", hub_auth: await opts.hubJwt!(), read_only: true, signed_in: true }
      : {
          channel: "claude_connector",
          signed_in: false,
          note: "This question comes from a Claude agent through the Hub Culture connector. Answer from Hub Culture's public knowledge; account actions such as sending Ven are not available here.",
        };
    const res = await this.fetchImpl(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.systemToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_type: "claude_connector", message, thread_id: opts.threadId, data }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new UpstreamError(`Zeke error (HTTP ${res.status})`, res.status, "zeke");
    return { ...parseZekeStream(await res.text()), withCallerContext };
  }
}

export function parseZekeStream(body: string): { answer: string; threadId?: string } {
  let answer = "";
  let threadId: string | undefined;
  let error: string | undefined;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: { event?: string; node?: string; content?: unknown; thread_id?: string; detail?: string };
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event.event === "start" && event.thread_id) threadId = event.thread_id;
    if (event.event === "error") error = event.detail ?? "unknown error";
    if (event.event === "node_complete" && !TOOL_NODES.has(event.node ?? "") && typeof event.content === "string") {
      if (event.content.trim()) answer = event.content.trim();
    }
  }
  if (!answer && error) throw new UpstreamError(`Zeke: ${error}`, 502, "zeke");
  return { answer, threadId };
}
