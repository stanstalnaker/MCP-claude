import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ, defineTool, type ToolDeps } from "./common.js";

export function registerZekeTools(server: McpServer, { session, zeke, hubid }: ToolDeps): void {
  if (zeke) {
    defineTool(server, session, {
      name: "zeke_ask",
      title: "Ask Zeke",
      description:
        "Ask Zeke, Hub Culture's assistant, about Hub Culture, Ven, hubs, events, news and pavilions. " +
        "Zeke answers as the signed-in member. Pass thread_id from a previous answer to continue that conversation.",
      scope: "zeke",
      input: { message: z.string().min(1).max(4000), thread_id: z.string().max(100).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async ({ message, thread_id }) => {
        const { answer, threadId } = await zeke.ask(message, { hubJwt: await session.hubJwt(), threadId: thread_id });
        return { answer: answer || "Zeke had no answer.", thread_id: threadId };
      },
    });
  }

  defineTool(server, session, {
    name: "zeke_list_knowledge",
    title: "Browse Zeke's public feeds",
    description: "Public data Zeke draws on: upcoming events, hub news, pavilions or store items across Hub Culture.",
    scope: "read",
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
