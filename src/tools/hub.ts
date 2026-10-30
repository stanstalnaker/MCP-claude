import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ, WRITE, defineTool, mapPage, pick, slimUser, type ToolDeps } from "./common.js";

// Hub Culture social layer on HubID: profile, people, friends, hubs, events, pavilions, messages, alerts.

const paging = {
  offset: z.number().int().min(0).optional().describe("Records to skip (default 0)"),
  limit: z.number().int().min(1).max(50).optional().describe("Page size, 1-50 (default 10)"),
};

function slimEvent(e: any) {
  return {
    ...pick(e, ["id", "title", "address", "timezone", "ticket_link", "private", "approved", "group", "url"]),
    description: typeof e?.description === "string" ? e.description.slice(0, 600) : undefined,
    start: e?.dates?.start?.dateTimeString ?? e?.start,
    end: e?.dates?.end?.dateTimeString ?? e?.end,
  };
}

function slimThread(t: any) {
  return {
    thread: t?.thread,
    subject: t?.subject,
    unread: t?.unread === 1 || t?.unread === true,
    last: typeof t?.last === "number" ? new Date(t.last * 1000).toISOString() : t?.last,
    creator: slimUser(t?.creator),
    participants: Array.isArray(t?.participants) ? t.participants.map(slimUser) : undefined,
    lastMessage: t?.lastMessage ? pick(t.lastMessage, ["id", "content", "timestamp"]) : undefined,
  };
}

export function registerHubTools(server: McpServer, { session, hubid }: ToolDeps): void {
  const call = async <T = any>(path: string, req: Parameters<typeof hubid.request>[1] = {}) =>
    hubid.request<T>(path, { ...req, jwt: await session.hubJwt() });

  // ── Read ────────────────────────────────────────────────────────────────

  defineTool(server, session, {
    name: "hub_get_me",
    title: "Get my Hub Culture profile",
    description: "The signed-in member's HubID profile: name, email, location, status, memberships and Ven balance.",
    scope: "read",
    input: {},
    annotations: READ,
    run: async () => {
      const me = await call<any>("/user");
      return {
        ...slimUser(me),
        email: me.email,
        ven_balance: me.ven_balance?.balance ?? me.ven_balance,
        memberships: me.memberships,
        statusInfo: me.statusInfo,
        is_merchant: me.is_merchant,
      };
    },
  });

  defineTool(server, session, {
    name: "hub_get_user",
    title: "Get a member",
    description: "Basic public information about a Hub Culture member by user id.",
    scope: "read",
    input: { user_id: z.number().int().positive() },
    annotations: READ,
    run: async ({ user_id }) => slimUser(await call(`/user/${user_id}`)),
  });

  defineTool(server, session, {
    name: "hub_search_users",
    title: "Search members",
    description: "Find Hub Culture members by name or email (3-50 characters). Use the returned id with other tools.",
    scope: "read",
    input: { search: z.string().min(3).max(50) },
    annotations: READ,
    run: async ({ search }) => mapPage(await call("/users/search", { query: { search } }), slimUser),
  });

  defineTool(server, session, {
    name: "hub_list_friends",
    title: "List my friends",
    description: "The signed-in member's friends, optionally filtered by name.",
    scope: "read",
    input: { name: z.string().min(2).max(250).optional().describe("Only friends whose name contains this"), ...paging },
    annotations: READ,
    run: async (q) => mapPage(await call("/friends", { query: q }), slimUser),
  });

  defineTool(server, session, {
    name: "hub_list_friend_requests",
    title: "List friend requests",
    description: "Friend requests waiting for the signed-in member (incoming) or sent by them (outgoing).",
    scope: "read",
    input: { direction: z.enum(["incoming", "outgoing"]).default("incoming"), ...paging },
    annotations: READ,
    run: async ({ direction, ...q }) =>
      call(direction === "incoming" ? "/v2/friends/requests" : "/v2/friends/pending", { query: q }),
  });

  defineTool(server, session, {
    name: "hub_list_my_hubs",
    title: "List my hubs",
    description: "Hubs (groups) the signed-in member belongs to.",
    scope: "read",
    input: {},
    annotations: READ,
    run: async () =>
      mapPage(await call("/user/hubs"), (h) => pick(h, ["id", "name", "description", "url", "timezone", "price", "privacy"])),
  });

  defineTool(server, session, {
    name: "hub_get_hub",
    title: "Get a hub",
    description: "A hub (group) by numeric id or URL slug.",
    scope: "read",
    input: { hub: z.union([z.number().int().positive(), z.string().min(1)]).describe("Hub id, or its URL slug such as 'davos'") },
    annotations: READ,
    run: async ({ hub }) => call(typeof hub === "number" || /^\d+$/.test(hub) ? `/group/id/${hub}` : `/group/url/${encodeURIComponent(hub)}`),
  });

  defineTool(server, session, {
    name: "hub_list_hub_members",
    title: "List hub members",
    description: "Members of a hub.",
    scope: "read",
    input: { hub_id: z.number().int().positive(), ...paging },
    annotations: READ,
    run: async ({ hub_id, ...q }) => mapPage(await call(`/group/id/${hub_id}/users`, { query: q }), slimUser),
  });

  defineTool(server, session, {
    name: "hub_list_hub_news",
    title: "List hub news",
    description: "Latest news articles of a hub.",
    scope: "read",
    input: { hub_id: z.number().int().positive(), ...paging },
    annotations: READ,
    run: async ({ hub_id, ...q }) => call(`/articles/group/${hub_id}/news`, { query: q }),
  });

  defineTool(server, session, {
    name: "hub_list_events",
    title: "List events",
    description:
      "Events in a hub, or across all hubs when hub_id is omitted. Newest first by default; past events are included, so compare 'end' with today for upcoming ones.",
    scope: "read",
    input: { hub_id: z.number().int().min(0).optional(), order: z.enum(["DESC", "ASC"]).optional(), ...paging },
    annotations: READ,
    run: async ({ hub_id, ...q }) => mapPage(await call(`/events/list/group/${hub_id ?? 0}`, { query: q }), slimEvent),
  });

  defineTool(server, session, {
    name: "hub_get_event",
    title: "Get an event",
    description: "Full details of one event.",
    scope: "read",
    input: { event_id: z.number().int().positive() },
    annotations: READ,
    run: async ({ event_id }) => call(`/event/${event_id}`),
  });

  defineTool(server, session, {
    name: "hub_list_pavilions",
    title: "List pavilions",
    description: "Hub Culture pavilions (physical venues), optionally filtered by title or territory.",
    scope: "read",
    input: { title: z.string().optional(), territory: z.string().optional(), ...paging },
    annotations: READ,
    run: async (q) =>
      mapPage(await call("/v2/pavilions/list", { query: q }), (p) =>
        pick(p, ["id", "name", "localename", "address", "timezone", "territory", "url", "latitude", "longitude"]),
      ),
  });

  defineTool(server, session, {
    name: "hub_get_pavilion",
    title: "Get a pavilion",
    description: "Details of one pavilion.",
    scope: "read",
    input: { pavilion_id: z.number().int().positive() },
    annotations: READ,
    run: async ({ pavilion_id }) => call(`/pavilions/${pavilion_id}`),
  });

  defineTool(server, session, {
    name: "hub_list_messages",
    title: "List my message threads",
    description: "The signed-in member's private message threads: inbox, sent or all.",
    scope: "read",
    input: { box: z.enum(["inbox", "sent", "all"]).default("inbox"), ...paging },
    annotations: READ,
    run: async ({ box, ...q }) => mapPage(await call(`/v2/messages/thread/${box}`, { query: q }), slimThread),
  });

  defineTool(server, session, {
    name: "hub_get_thread",
    title: "Read a message thread",
    description: "Messages in one private thread.",
    scope: "read",
    input: { thread_id: z.number().int().positive(), ...paging },
    annotations: READ,
    run: async ({ thread_id, ...q }) => call(`/v2/messages/thread/${thread_id}`, { query: q }),
  });

  defineTool(server, session, {
    name: "hub_list_alerts",
    title: "List my alerts",
    description: "The signed-in member's notifications.",
    scope: "read",
    input: { filter: z.enum(["unread", "read", "all"]).default("unread"), ...paging },
    annotations: READ,
    run: async ({ filter, ...q }) => call(filter === "all" ? "/v2/alerts" : `/v2/alerts/${filter}`, { query: q }),
  });

  // ── Write ───────────────────────────────────────────────────────────────

  defineTool(server, session, {
    name: "hub_send_message",
    title: "Send a private message",
    description: "Start a new private message thread with one or more members (by user id). Sent as the signed-in member.",
    scope: "write",
    input: {
      recipients: z.array(z.number().int().positive()).min(1).max(20),
      subject: z.string().max(250).optional(),
      content: z.string().min(1).max(10000),
    },
    annotations: WRITE,
    run: async (body) => {
      const res = await call<any>("/messages/thread", { method: "POST", body });
      return { thread_id: res?.id ?? res?.thread?.thread, sent: true };
    },
  });

  defineTool(server, session, {
    name: "hub_reply_to_thread",
    title: "Reply to a message thread",
    description: "Reply in an existing private thread as the signed-in member.",
    scope: "write",
    input: { thread_id: z.number().int().positive(), content: z.string().min(1).max(10000) },
    annotations: WRITE,
    run: async ({ thread_id, content }) => {
      await call(`/messages/thread/${thread_id}`, { method: "PUT", body: { content } });
      return { thread_id, sent: true };
    },
  });

  defineTool(server, session, {
    name: "hub_send_friend_request",
    title: "Send a friend request",
    description: "Ask a member to be friends, by user id or email.",
    scope: "write",
    input: {
      user_id: z.number().int().positive().optional(),
      email: z.string().email().optional(),
      message: z.string().min(4).max(500),
    },
    annotations: WRITE,
    run: async ({ user_id, email, message }) => {
      if (!user_id && !email) throw new Error("Give user_id or email");
      return call("/friends", { method: "POST", body: { id: user_id, email, message } });
    },
  });

  defineTool(server, session, {
    name: "hub_answer_friend_request",
    title: "Accept or decline a friend request",
    description: "Accept or decline an incoming friend request (id from hub_list_friend_requests).",
    scope: "write",
    input: { request_id: z.number().int().positive(), accept: z.boolean() },
    annotations: WRITE,
    run: async ({ request_id, accept }) => {
      await call(`/friend/request/${request_id}`, { method: accept ? "PUT" : "DELETE" });
      return { request_id, accepted: accept };
    },
  });

  defineTool(server, session, {
    name: "hub_post_to_hub_wall",
    title: "Post to a hub wall",
    description: "Post a message on a hub's wall, visible to the hub's members.",
    scope: "write",
    input: { hub_id: z.number().int().positive(), message: z.string().min(1).max(5000) },
    annotations: WRITE,
    run: async ({ hub_id, message }) => call(`/wall/group/${hub_id}/add`, { method: "POST", body: { message } }),
  });

  defineTool(server, session, {
    name: "hub_create_event",
    title: "Create an event",
    description: "Create an event in a hub. It may need hub approval before it is visible.",
    scope: "write",
    input: {
      hub_id: z.number().int().positive(),
      title: z.string().min(1).max(255),
      description: z.string().min(1).max(20000),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
      start_time: z.string().regex(/^\d{2}:\d{2}$/).describe("HH:MM, 24h"),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end_time: z.string().regex(/^\d{2}:\d{2}$/),
      address: z.string().min(1).max(255),
      timezone: z.string().max(255).optional().describe("e.g. Europe/Zurich"),
      ticket_link: z.string().url().max(255).optional(),
      private: z.boolean().optional(),
      share: z.boolean().optional().describe("Also post it to the hub's news feed"),
    },
    annotations: WRITE,
    run: async (e) =>
      slimEvent(
        await call("/events/new/v2", {
          method: "POST",
          body: {
            group: e.hub_id,
            title: e.title,
            description: e.description,
            startDate: e.start_date,
            startTime: e.start_time,
            endDate: e.end_date,
            endTime: e.end_time,
            address: e.address,
            timezone: e.timezone,
            ticket_link: e.ticket_link,
            private: e.private,
            share: e.share,
          },
        }),
      ),
  });

  defineTool(server, session, {
    name: "hub_set_status_message",
    title: "Set my status message",
    description: "Update the signed-in member's public status message.",
    scope: "write",
    input: { message: z.string().min(1).max(500) },
    annotations: { ...WRITE, idempotentHint: true },
    run: async ({ message }) => call("/user/status-message", { method: "PUT", body: { message } }),
  });
}
