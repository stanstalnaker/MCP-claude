import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ, defineTool, type ToolDeps } from "./common.js";

export function registerZekeTools(server: McpServer, deps: ToolDeps): void {
  const { zeke, hubid } = deps;
  if (zeke) {
    defineTool(server, deps, {
      name: "ask_zeke",
      title: "Ask Zeke",
      description:
        "Ask Zeke, Hub Culture's assistant, about Hub Culture, Ven, hubs, events, news and pavilions. " +
        "Zeke answers from Hub Culture's public knowledge and takes no actions. Pass thread_id from a previous answer to continue that conversation.",
      scope: "zeke:ask",
      input: { message: z.string().min(1).max(4000), thread_id: z.string().max(100).optional() },
      annotations: READ,
      run: async ({ message, thread_id }) => {
        const { answer, threadId } = await zeke.ask(message, { threadId: thread_id });
        return { answer: answer || "Zeke had no answer.", thread_id: threadId };
      },
    });
  }

  defineTool(server, deps, {
    name: "zeke_list_knowledge",
    title: "Browse Zeke's public feeds",
    description: "Public data Zeke draws on: upcoming events, hub news, pavilions or store items across Hub Culture.",
    scope: "hubs:read",
    input: {
      feed: z.enum(["events", "news", "pavilions", "store-items"]),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: READ,
    run: async ({ feed, limit }) => {
      const data = await hubid.request<unknown>(`/zeke/${feed}/all`, { key: "public" });
      // These feeds return everything at once; keep the agent's context small.
      return Array.isArray(data) ? { total: data.length, items: data.slice(0, limit) } : data;
    },
  });
}
