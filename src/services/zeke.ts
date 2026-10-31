import { UpstreamError } from "./hubid.js";

// Zeke (hub-culture/zeke-ai-server). POST /chat takes the system bearer token and streams SSE
// lines `data: {...}`. Like src/channels/zeke_client.py there, the answer is the last non-tool
// `node_complete`.
//
// The caller's HubID JWT is deliberately NOT forwarded (no data.hub_auth): with it, Zeke's own
// send_ven tool can POST /transactions as the caller, outside this connector's Ven mandate.
// Without it Zeke answers from its public knowledge, which keeps ask_zeke read-only.

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
  constructor(
    private readonly baseUrl: string,
    private readonly systemToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ask(message: string, opts: { threadId?: string } = {}): Promise<{ answer: string; threadId?: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.systemToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        user_type: "claude_connector",
        message,
        thread_id: opts.threadId,
        data: {
          channel: "claude_connector",
          signed_in: false,
          note: "This question comes from a Claude agent through the Hub Culture connector. Answer from Hub Culture's public knowledge; account actions such as sending Ven are not available here.",
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new UpstreamError(`Zeke error (HTTP ${res.status})`, res.status, "zeke");
    return parseZekeStream(await res.text());
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
