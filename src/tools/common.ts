import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { Config, Scope } from "../config.js";
import type { HubIdClient } from "../services/hubid.js";
import { UpstreamError } from "../services/hubid.js";
import type { PaymentsClient } from "../services/payments.js";
import type { ZekeClient } from "../services/zeke.js";
import { AuthRequiredError, type HubSession } from "../session.js";

export type ToolDeps = {
  config: Config;
  session: HubSession;
  hubid: HubIdClient;
  payments?: PaymentsClient;
  zeke?: ZekeClient;
  fetchImpl: typeof fetch;
};

type ToolSpec<Shape extends ZodRawShapeCompat> = {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  input: Shape;
  annotations: ToolAnnotations;
  run: (args: ShapeOutput<Shape>) => Promise<unknown>;
};

/** Registers a tool only when the signed-in user granted its scope, so agents never see tools they can't use. */
export function defineTool<Shape extends ZodRawShapeCompat>(server: McpServer, session: HubSession, spec: ToolSpec<Shape>): void {
  if (!session.scopes.includes(spec.scope)) return;
  server.registerTool(
    spec.name,
    { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: { title: spec.title, ...spec.annotations } },
    (async (args: ShapeOutput<Shape>): Promise<CallToolResult> => {
      try {
        const result = await spec.run(args);
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
      }
    }) as never,
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof AuthRequiredError) return err.message;
  if (err instanceof UpstreamError) {
    if (err.status === 401) return "Hub Culture rejected the sign-in. Reconnect the connector and try again.";
    if (err.status === 403) return `Not allowed: ${err.message}`;
    if (err.status === 404) return `Not found: ${err.message}`;
    return err.message;
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "The Hub Culture service took too long to answer. Try again.";
  if (err instanceof ToolInputError) return err.message;
  console.error("tool error:", err);
  return "Something went wrong talking to Hub Culture.";
}

export class ToolInputError extends Error {}

export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

type AnyUser = Record<string, unknown> & { picture?: { thumbnail?: string } | unknown };

/** HubID user objects carry profiles, memberships, banking fields and more. Agents get the public basics. */
export function slimUser(user: unknown): Record<string, unknown> | null {
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const u = user as AnyUser;
  const picture = u.picture && typeof u.picture === "object" ? (u.picture as { thumbnail?: string }).thumbnail : undefined;
  return pick({ ...u, picture }, ["id", "name", "first", "last", "url", "location", "picture", "status"]);
}

export function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") out[key] = obj[key];
  return out;
}

/** Maps `items` of a HubID paged response ({total, offset, limit, items}), leaving the paging fields. */
export function mapPage<T>(page: unknown, fn: (item: any) => T): unknown {
  if (Array.isArray(page)) return page.map(fn);
  if (page && typeof page === "object" && Array.isArray((page as { items?: unknown }).items)) {
    const p = page as { items: unknown[]; total?: number; offset?: number; limit?: number };
    return { total: p.total, offset: p.offset, limit: p.limit, items: p.items.map(fn) };
  }
  return page;
}
