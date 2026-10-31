import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { createHash } from "node:crypto";
import type { Config, Scope } from "../config.js";
import type { HubIdClient } from "../services/hubid.js";
import { UpstreamError } from "../services/hubid.js";
import type { PaymentsClient } from "../services/payments.js";
import type { ZekeClient } from "../services/zeke.js";
import { AuthRequiredError, type HubSession } from "../session.js";
import type { Store } from "../store.js";

export type ToolDeps = {
  config: Config;
  store: Store;
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

/**
 * Registers a tool only when the token holds its scope and an admin hasn't switched it off
 * (DISABLED_TOOLS), so agents never see tools they can't use. Every call is rate-limited per
 * sign-in, and every write leaves an audit record.
 */
export function defineTool<Shape extends ZodRawShapeCompat>(server: McpServer, deps: ToolDeps, spec: ToolSpec<Shape>): void {
  const { session, config, store } = deps;
  if (!session.scopes.includes(spec.scope) || config.disabledTools.includes(spec.name)) return;
  const isWrite = spec.annotations.readOnlyHint !== true;
  server.registerTool(
    spec.name,
    { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: { title: spec.title, ...spec.annotations } },
    (async (args: ShapeOutput<Shape>): Promise<CallToolResult> => {
      let result: unknown;
      let failed: unknown;
      try {
        await rateLimit(store, session.grantId, isWrite ? "write" : "read", isWrite ? config.rateLimitPerMinute.write : config.rateLimitPerMinute.read);
        result = await spec.run(args);
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
      } catch (err) {
        failed = err;
        return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
      } finally {
        if (isWrite && !(failed instanceof RateLimitError)) audit(session, spec.name, args, failed ? { error: errorMessage(failed) } : result);
      }
    }) as never,
  );
}

export class RateLimitError extends Error {}

/** Fixed one-minute window per sign-in and kind. Approximate under concurrency, which is fine for a guard. */
async function rateLimit(store: Store, grantId: string, kind: "read" | "write", perMinute: number): Promise<void> {
  const window = Math.floor(Date.now() / 60_000);
  const key = `rate:${grantId}:${kind}:${window}`;
  const count = ((await store.get<number>(key)) ?? 0) + 1;
  await store.set(key, count, 61);
  if (count > perMinute) {
    throw new RateLimitError(`Rate limit: at most ${perMinute} ${kind} calls a minute. Wait a moment and try again.`);
  }
}

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

/**
 * PRD audit record: SHA-256 over principal, tool, arguments and result, plus a timestamp. Written to the
 * log as one JSON line; forwarding it to OAI.io waits on OAI.io's write API (PRD open question).
 */
function audit(session: HubSession, tool: string, args: unknown, result: unknown): void {
  const entry = {
    principal: session.principal,
    hub_user_id: session.hubUserId,
    tool,
    args_sha256: sha256(args),
    result_sha256: sha256(result),
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify({ audit: { ...entry, sha256: sha256(entry) } }));
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
  if (err instanceof ToolInputError || err instanceof RateLimitError) return err.message;
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

/**
 * Runs a write at most once per idempotency key (per sign-in and tool, kept 24 hours), so a retried
 * call returns the first result instead of acting twice. No key = no protection.
 */
export async function once<T>(deps: ToolDeps, tool: string, key: string | undefined, fn: () => Promise<T>): Promise<T | { replayed: true; result: T }> {
  if (!key) return fn();
  const storeKey = `idem:${deps.session.grantId}:${tool}:${createHash("sha256").update(key).digest("base64url")}`;
  const previous = await deps.store.get<{ result?: T; running?: true }>(storeKey);
  if (previous?.running) throw new ToolInputError("A call with this idempotency key is still running or timed out. Check the transaction history before trying again with a new key.");
  if (previous) return { replayed: true, result: previous.result as T };
  await deps.store.set(storeKey, { running: true }, 120);
  try {
    const result = await fn();
    await deps.store.set(storeKey, { result }, 24 * 60 * 60);
    return result;
  } catch (err) {
    // A timeout leaves the outcome unknown (Ven may have moved), so the key stays blocked; any other failure frees it.
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    if (timedOut) await deps.store.set(storeKey, { running: true }, 24 * 60 * 60);
    else await deps.store.del(storeKey);
    throw err;
  }
}
