import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ, ToolInputError, defineTool, type ToolDeps } from "./common.js";

const THREAD_TTL = 30 * 24 * 60 * 60;

export function registerZekeTools(server: McpServer, deps: ToolDeps): void {
  const { zeke, hubid, session, store } = deps;
  if (zeke) {
    defineTool(server, deps, {
      name: "ask_zeke",
      title: "Ask Zeke",
      description:
        "Ask Zeke, Hub Culture's assistant, about Hub Culture, Ven, hubs, events, news and pavilions. " +
        "Zeke answers with the caller's own context (who they are, their friends, what Zeke remembers about them) and takes no actions. " +
        "Pass thread_id from a previous answer to continue that conversation.",
      scope: "zeke:ask",
      input: { message: z.string().min(1).max(4000), thread_id: z.string().max(100).optional() },
      annotations: READ,
      run: async ({ message, thread_id }) => {
        // Zeke resumes any thread id it's given, and threads carry the caller's context, so only
        // continue threads this connector started for this same HubID.
        if (thread_id && !(await store.get(`zekethread:${session.hubUserId}:${thread_id}`))) {
          throw new ToolInputError("Unknown thread_id. Leave it out to start a new conversation with Zeke.");
        }
        const { answer, threadId, withCallerContext } = await zeke.ask(message, { hubJwt: session.hubJwt, threadId: thread_id });
        if (threadId) await store.set(`zekethread:${session.hubUserId}:${threadId}`, true, THREAD_TTL);
        return {
          answer: answer || "Zeke had no answer.",
          thread_id: threadId,
          // false only while Zeke lacks read-only mode; it then answers from public knowledge.
          caller_context: withCallerContext,
        };
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
