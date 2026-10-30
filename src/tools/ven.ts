import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UpstreamError } from "../services/hubid.js";
import { DESTRUCTIVE, READ, WRITE, ToolInputError, defineTool, pick, slimUser, type ToolDeps } from "./common.js";

// Ven: wallet (HubID), public rates (ven.vc rates API) and buying Ven (payments interchange).

function slimTransaction(t: any) {
  return {
    ...pick(t, ["id", "from", "to", "amount", "message"]),
    timestamp: typeof t?.timestamp === "number" ? new Date(t.timestamp * 1000).toISOString() : t?.timestamp,
    user_from: slimUser(t?.user_from),
    user_to: slimUser(t?.user_to),
  };
}

export function registerVenTools(server: McpServer, deps: ToolDeps): void {
  const { session, hubid, config, payments, fetchImpl } = deps;
  const call = async <T = any>(path: string, req: Parameters<typeof hubid.request>[1] = {}) =>
    hubid.request<T>(path, { ...req, jwt: await session.hubJwt() });

  const rates = async (path: string) => {
    const res = await fetchImpl(config.venRatesUrl + path, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new UpstreamError(`Ven rates API error (HTTP ${res.status})`, res.status, "ven-rates");
    return res.json();
  };

  // ── Wallet (read) ───────────────────────────────────────────────────────

  defineTool(server, session, {
    name: "ven_get_balance",
    title: "Get my Ven balance",
    description: "The signed-in member's Ven wallet balance.",
    scope: "read",
    input: {},
    annotations: READ,
    run: async () => {
      const wallet = await call<{ balance?: number } | null>("/balance");
      return { balance: wallet?.balance ?? 0, currency: "VEN" };
    },
  });

  defineTool(server, session, {
    name: "ven_list_transactions",
    title: "List my Ven transactions",
    description: "The signed-in member's Ven transfers, newest first.",
    scope: "read",
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

  defineTool(server, session, {
    name: "ven_get_transaction",
    title: "Get a Ven transaction",
    description: "One of the signed-in member's Ven transactions by id.",
    scope: "read",
    input: { transaction_id: z.number().int().positive() },
    annotations: READ,
    run: async ({ transaction_id }) => slimTransaction(await call(`/transactions/${transaction_id}`)),
  });

  // ── Public market data ──────────────────────────────────────────────────

  defineTool(server, session, {
    name: "ven_get_exchange_rates",
    title: "Get Ven exchange rates",
    description: "Current Ven exchange rates against fiat currencies and other assets.",
    scope: "read",
    input: {},
    annotations: READ,
    run: () => rates("/api/ven/exchange"),
  });

  defineTool(server, session, {
    name: "ven_get_rate_history",
    title: "Get Ven rate history",
    description: "Historical summary of the Ven rate against one currency.",
    scope: "read",
    input: { currency: z.string().regex(/^[A-Za-z]{3,5}$/).describe("Ticker such as USD, EUR, GBP") },
    annotations: READ,
    run: ({ currency }) => rates(`/api/ven/rates-summary/${currency.toUpperCase()}`),
  });

  defineTool(server, session, {
    name: "ven_get_supply_stats",
    title: "Get Ven supply statistics",
    description: "Public statistics on Ven in circulation.",
    scope: "read",
    input: {},
    annotations: READ,
    run: () => hubid.request("/statistic/ven", { key: "public" }),
  });

  // ── Moving Ven ──────────────────────────────────────────────────────────

  defineTool(server, session, {
    name: "ven_send",
    title: "Send Ven",
    description:
      `Send Ven from the signed-in member's wallet to another member (by user id) or to an email address. ` +
      `This moves real value and cannot be undone: confirm the recipient and amount with the user first. ` +
      `Up to ${config.maxVenPerTransfer} Ven per transfer through this connector; at most 2 decimal places.`,
    scope: "ven:transfer",
    input: {
      to_user_id: z.number().int().positive().optional(),
      to_email: z.string().email().optional(),
      amount: z.number().positive(),
      message: z.string().max(250).optional(),
    },
    annotations: DESTRUCTIVE,
    run: async ({ to_user_id, to_email, amount, message }) => {
      if (!to_user_id === !to_email) throw new ToolInputError("Give exactly one of to_user_id or to_email.");
      if (Math.round(amount * 100) !== amount * 100) throw new ToolInputError("Amounts can have at most 2 decimal places.");
      if (amount > config.maxVenPerTransfer) {
        throw new ToolInputError(`This connector sends at most ${config.maxVenPerTransfer} Ven per transfer. Use Hub Culture directly for larger amounts.`);
      }
      if (to_user_id === session.hubUserId) throw new ToolInputError("You can't send Ven to yourself.");
      const res = await call<any>("/transactions", {
        method: "POST",
        body: { to: to_user_id, email: to_email, amount, message, hide: 0 },
      });
      // Success is final even if the notification email failed; never retry a successful send.
      return { sent: true, amount: res?.amount ?? amount, to: res?.to ?? to_user_id, email: res?.email || to_email, balance_after: res?.balance };
    },
  });

  defineTool(server, session, {
    name: "ven_request",
    title: "Request Ven",
    description: "Ask another member to send the signed-in member Ven. They get an alert; no Ven moves until they pay.",
    scope: "write",
    input: {
      from_user_id: z.number().int().positive(),
      amount: z.number().int().positive().describe("Whole Ven"),
      message: z.string().min(1).max(250),
    },
    annotations: WRITE,
    run: async ({ from_user_id, amount, message }) =>
      call("/v2/transactions/request", { method: "POST", body: { user: from_user_id, amount, message } }),
  });

  // ── Buying Ven (payments interchange) ───────────────────────────────────

  if (!payments) return;

  defineTool(server, session, {
    name: "ven_purchase_quote",
    title: "Quote a Ven purchase",
    description:
      "Price a Ven purchase in a fiat currency at the current rate, and show the member's remaining 24-hour purchase allowance. Minimum 110 Ven.",
    scope: "read",
    input: { ven_amount: z.number().min(110), currency: z.string().regex(/^[A-Za-z]{3}$/).describe("USD, EUR, ...") },
    annotations: READ,
    run: async ({ ven_amount, currency }) =>
      payments.request(session.hubUserId, "POST", "/v1/quote", { ven_amount: String(ven_amount), currency: currency.toUpperCase() }),
  });

  defineTool(server, session, {
    name: "ven_list_purchase_orders",
    title: "List my Ven purchases",
    description: "The signed-in member's Ven purchase orders and their status.",
    scope: "read",
    input: {},
    annotations: READ,
    run: () => payments.request(session.hubUserId, "GET", "/v1/orders"),
  });

  defineTool(server, session, {
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
