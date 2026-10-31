import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UpstreamError } from "../services/hubid.js";
import { DESTRUCTIVE, READ, WRITE, ToolInputError, defineTool, once, pick, slimUser, type ToolDeps } from "./common.js";

// Ven: wallet (HubID), public prices (ven.vc rates API) and buying Ven (payments interchange).
//
// Mandate (PRD "Mandate"): every ven_send needs a purpose and an idempotency key.
// - Agents send through HubID's /mandala/send, where the owner's custodian policy (per-send cap,
//   rolling-window cap, recipient allowlist, approval threshold) is enforced and large sends come
//   back as pending_approval. That needs MANDALA_ENFORCE_VEN_SEND=true in HubID.
// - Members send through /transactions, which has no mandate, so the connector enforces one
//   (VEN_SEND_PER_TX, VEN_SEND_PER_DAY over a rolling 24 hours).
// The connector caps also apply to agents, as a ceiling over whatever their owner set.

const DAY = 24 * 60 * 60;

function slimTransaction(t: any) {
  return {
    ...pick(t, ["id", "from", "to", "amount", "message"]),
    timestamp: typeof t?.timestamp === "number" ? new Date(t.timestamp * 1000).toISOString() : t?.timestamp,
    user_from: slimUser(t?.user_from),
    user_to: slimUser(t?.user_to),
  };
}

const requiredIdempotencyKey = z
  .string()
  .min(8)
  .max(100)
  .describe("A unique key for this transfer, e.g. a UUID. Reuse the SAME key if you retry, so Ven never moves twice.");

export function registerVenTools(server: McpServer, deps: ToolDeps): void {
  const { session, hubid, config, payments, fetchImpl, store } = deps;
  const call = async <T = any>(path: string, req: Parameters<typeof hubid.request>[1] = {}) =>
    hubid.request<T>(path, { ...req, jwt: await session.hubJwt() });
  const isAgent = session.principal === "agent";

  const rates = async (path: string) => {
    const res = await fetchImpl(config.venRatesUrl + path, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new UpstreamError(`Ven rates API error (HTTP ${res.status})`, res.status, "ven-rates");
    return res.json();
  };

  // Rolling 24-hour total of Ven sent through the connector by this HubID.
  const spentKey = `venspent:${session.hubUserId}`;
  const spentToday = async () => {
    const now = Math.floor(Date.now() / 1000);
    const entries = ((await store.get<{ at: number; amount: number }[]>(spentKey)) ?? []).filter((e) => now - e.at < DAY);
    return { entries, total: entries.reduce((sum, e) => sum + e.amount, 0) };
  };

  // ── Read ────────────────────────────────────────────────────────────────

  defineTool(server, deps, {
    name: "ven_get_price",
    title: "Get the Ven price",
    description: "Current Ven exchange rates against fiat currencies and other assets, and the Ven basket.",
    scope: "ven:read",
    input: {},
    annotations: READ,
    run: async () => {
      const [exchange, basket] = await Promise.allSettled([rates("/api/ven/exchange"), rates("/api/ven/baskets")]);
      if (exchange.status === "rejected") throw exchange.reason;
      return { exchange: exchange.value, basket: basket.status === "fulfilled" ? basket.value : undefined };
    },
  });

  defineTool(server, deps, {
    name: "ven_get_rate_history",
    title: "Get Ven rate history",
    description: "Historical summary of the Ven rate against one currency.",
    scope: "ven:read",
    input: { currency: z.string().regex(/^[A-Za-z]{3,5}$/).describe("Ticker such as USD, EUR, GBP") },
    annotations: READ,
    run: ({ currency }) => rates(`/api/ven/rates-summary/${currency.toUpperCase()}`),
  });

  defineTool(server, deps, {
    name: "ven_get_supply_stats",
    title: "Get Ven supply statistics",
    description: "Public statistics on Ven in circulation.",
    scope: "ven:read",
    input: {},
    annotations: READ,
    run: () => hubid.request("/statistic/ven", { key: "public" }),
  });

  defineTool(server, deps, {
    name: "ven_get_balance",
    title: "Get my Ven balance",
    description: "The caller's Ven balance, and how much more it can send through this connector in the next 24 hours.",
    scope: "ven:read",
    input: {},
    annotations: READ,
    run: async () => {
      const wallet = await call<{ balance?: number } | null>("/balance");
      const { total } = await spentToday();
      return {
        balance: wallet?.balance ?? 0,
        currency: "VEN",
        connector_mandate: { per_send: config.venSendPerTx, per_24h: config.venSendPerDay, remaining_24h: Math.max(0, config.venSendPerDay - total) },
      };
    },
  });

  defineTool(server, deps, {
    name: "ven_list_transactions",
    title: "List my Ven transactions",
    description: "The caller's Ven transfers, newest first.",
    scope: "ven:read",
    input: {
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: READ,
    run: async (q) => {
      const page = await call<any>("/v2/transactions", { query: q });
      return { total: page?.total, offset: page?.offset, limit: page?.limit, items: (page?.items ?? []).map(slimTransaction) };
    },
  });

  defineTool(server, deps, {
    name: "ven_get_transaction",
    title: "Get a Ven transaction",
    description: "One of the caller's Ven transactions by id.",
    scope: "ven:read",
    input: { transaction_id: z.number().int().positive() },
    annotations: READ,
    run: async ({ transaction_id }) => slimTransaction(await call(`/transactions/${transaction_id}`)),
  });

  // ── Moving Ven ──────────────────────────────────────────────────────────

  defineTool(server, deps, {
    name: "ven_request",
    title: "Request Ven",
    description: "Ask another member to send the caller Ven. They get an alert; no Ven moves until they pay.",
    scope: "ven:request",
    input: {
      from_user_id: z.number().int().positive(),
      amount: z.number().int().positive().describe("Whole Ven"),
      message: z.string().min(1).max(250),
      idempotency_key: requiredIdempotencyKey,
    },
    annotations: WRITE,
    run: ({ from_user_id, amount, message, idempotency_key }) =>
      once(deps, "ven_request", idempotency_key, () =>
        call(isAgent ? "/mandala/request" : "/v2/transactions/request", {
          method: "POST",
          key: isAgent ? "none" : "private",
          body: { user: from_user_id, amount, message },
        }),
      ),
  });

  defineTool(server, deps, {
    name: "ven_send",
    title: "Send Ven",
    description:
      "Send Ven from the caller's wallet to a member (by user id) or an email address. This moves real value and cannot be undone: " +
      "confirm the recipient and amount with the user first. Needs a purpose and an idempotency key; reuse the key on retries. " +
      `Through this connector: at most ${config.venSendPerTx} Ven per send and ${config.venSendPerDay} Ven per 24 hours, 2 decimal places. ` +
      "An agent's own mandate can be lower, and large agent sends can come back as pending_approval for the owner to confirm in Hub Culture.",
    scope: "ven:send",
    input: {
      to_user_id: z.number().int().positive().optional(),
      to_email: z.string().email().optional(),
      amount: z.number().positive(),
      purpose: z.string().min(3).max(250).describe("Why the Ven is being sent. Shown to the recipient and kept in the audit record."),
      idempotency_key: requiredIdempotencyKey,
    },
    annotations: DESTRUCTIVE,
    run: async ({ to_user_id, to_email, amount, purpose, idempotency_key }) => {
      if (!to_user_id === !to_email) throw new ToolInputError("Give exactly one of to_user_id or to_email.");
      if (Math.round(amount * 100) !== amount * 100) throw new ToolInputError("Amounts can have at most 2 decimal places.");
      if (to_user_id === session.hubUserId) throw new ToolInputError("You can't send Ven to yourself.");

      return once(deps, "ven_send", idempotency_key, async () => {
        if (amount > config.venSendPerTx) {
          throw new ToolInputError(`This connector sends at most ${config.venSendPerTx} Ven per transfer. Use Hub Culture directly for larger amounts.`);
        }
        const { entries, total } = await spentToday();
        if (total + amount > config.venSendPerDay) {
          throw new ToolInputError(
            `That would pass the ${config.venSendPerDay} Ven per 24 hours limit for this connector (${Math.max(0, config.venSendPerDay - total)} Ven left). Use Hub Culture directly, or try later.`,
          );
        }

        const body = { to: to_user_id, email: to_email, amount, message: purpose, hide: 0 };
        const res = isAgent
          ? await call<any>("/mandala/send", { method: "POST", key: "none", headers: { "Idempotency-Key": idempotency_key }, body })
          : await call<any>("/transactions", { method: "POST", body });

        if (res?.status === "pending_approval") {
          return {
            status: "pending_approval",
            approval_id: res.approval_id,
            amount: res.amount ?? amount,
            next_step: "The agent's owner (custodian) must approve this send in Hub Culture before any Ven moves.",
          };
        }
        await store.set(spentKey, [...entries, { at: Math.floor(Date.now() / 1000), amount }], DAY);
        // Success is final even if the notification email failed; never retry a successful send.
        return { status: "sent", amount: res?.amount ?? amount, to: res?.to ?? to_user_id, email: res?.email || to_email, balance_after: res?.balance };
      });
    },
  });

  // ── Buying Ven (payments interchange) ───────────────────────────────────

  if (!payments) return;

  defineTool(server, deps, {
    name: "ven_purchase_quote",
    title: "Quote a Ven purchase",
    description:
      "Price a Ven purchase in a fiat currency at the current rate, and show the caller's remaining 24-hour purchase allowance. Minimum 110 Ven.",
    scope: "ven:read",
    input: { ven_amount: z.number().min(110), currency: z.string().regex(/^[A-Za-z]{3}$/).describe("USD, EUR, ...") },
    annotations: READ,
    run: async ({ ven_amount, currency }) =>
      payments.request(session.hubUserId, "POST", "/v1/quote", { ven_amount: String(ven_amount), currency: currency.toUpperCase() }),
  });

  defineTool(server, deps, {
    name: "ven_list_purchase_orders",
    title: "List my Ven purchases",
    description: "The caller's Ven purchase orders and their status.",
    scope: "ven:read",
    input: {},
    annotations: READ,
    run: () => payments.request(session.hubUserId, "GET", "/v1/orders"),
  });

  defineTool(server, deps, {
    name: "ven_create_purchase_order",
    title: "Start a Ven purchase",
    description:
      "Create an order to buy Ven with a card. Returns a payment_url the member must open to pay; nothing is charged until they do. " +
      "Large orders above the 24-hour cap come back as approval_required instead.",
    scope: "ven:purchase",
    input: { ven_amount: z.number().min(110), currency: z.string().regex(/^[A-Za-z]{3}$/) },
    annotations: WRITE,
    run: async ({ ven_amount, currency }) => {
      const me = await call<any>("/user");
      return payments.request(session.hubUserId, "POST", "/v1/orders", {
        ven_amount: String(ven_amount),
        currency: currency.toUpperCase(),
        buyer: { email: me.email, first_name: me.first, last_name: me.last },
      });
    },
  });
}
