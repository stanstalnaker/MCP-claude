import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { redirectAllowed } from "../src/oauth/provider.js";
import { signPaymentsRequest } from "../src/services/payments.js";
import { parseZekeStream } from "../src/services/zeke.js";
import { MemoryStore } from "../src/store.js";

const PUBLIC_URL = "https://mcp.hubculture.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

function envelope(data: unknown, status = 200) {
  return new Response(JSON.stringify({ status: "success", errors: [], data, code: status }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { url: URL; method: string; headers: Record<string, string>; body?: string };

/** Stands in for HubID, the payments interchange and Zeke. */
function fakeBackends(state: { agentExchanges: number; zekeReadOnly: boolean }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { url, method: init.method ?? "GET", headers, body: init.body as string | undefined };
    calls.push(call);

    if (url.host === "id.hubculture.test") {
      if (url.pathname === "/token" && call.method === "PUT") {
        expect(headers["public-key"]).toBe("pub");
        return envelope({ token: fakeJwt({ sub: 42, iat: Math.floor(Date.now() / 1000) - 100, exp: Math.floor(Date.now() / 1000) + 86400 }) });
      }
      if (url.pathname.startsWith("/zeke/")) return envelope([{ id: 1 }, { id: 2 }, { id: 3 }]);
      if (url.pathname === "/mandala/key/token") {
        expect(headers["private-key"]).toBeUndefined();
        const { key } = JSON.parse(call.body!);
        if (key !== "agent-key-1") return new Response(JSON.stringify({ status: "error", errors: ["Invalid or revoked key."], data: null }), { status: 401 });
        state.agentExchanges++;
        return envelope({ token: fakeJwt({ sub: 654408, iat: Math.floor(Date.now() / 1000), nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 }), user_id: 654408 });
      }
      if (url.pathname === "/mandala/send") {
        expect(headers["idempotency-key"]).toBeTruthy();
        const body = JSON.parse(call.body!);
        if (body.amount >= 50) return new Response(JSON.stringify({ status: "pending_approval", approval_id: 31, amount: body.amount }), { status: 202 });
        return envelope({ to: body.to, amount: body.amount, balance: 90 });
      }
      expect(headers["private-key"]).toBe("priv");
      expect(headers.authorization).toMatch(/^Bearer /);
      const sub = JSON.parse(Buffer.from(headers.authorization.split(".")[1], "base64url").toString()).sub;
      if (url.pathname === "/user" && sub === 654408) {
        return envelope({ id: 654408, name: "Vela Lumen" });
      }
      if (url.pathname === "/user") {
        return envelope({ id: 42, name: "Jane Doe", first: "Jane", last: "Doe", email: "jane@example.com", ven_balance: { balance: 500 }, profile: { banking_iban: "SECRET" } });
      }
      if (url.pathname === "/balance") return envelope({ user: 42, balance: 500 });
      if (url.pathname === "/transactions" && call.method === "POST") {
        const body = JSON.parse(call.body!);
        return envelope({ to: body.to, email: "", amount: body.amount, balance: 500 - body.amount });
      }
      if (url.pathname === "/friends") {
        return envelope({ total: 1, offset: 0, limit: 10, items: [{ id: 7, name: "Sam", email: "sam@example.com", profile: { banking_iban: "X" }, picture: { thumbnail: "t.jpg" } }] });
      }
      return envelope(null, 404);
    }

    if (url.host === "pay.hubculture.test") {
      const ts = Number(headers["x-pay-timestamp"]);
      const expected = signPaymentsRequest("paysecret", ts, call.method, url.pathname + url.search, Number(headers["x-pay-user"]), headers["x-pay-role"], call.body ?? "");
      expect(headers["x-pay-signature"]).toBe(expected);
      expect(headers["x-pay-role"]).toBe("buyer");
      return new Response(JSON.stringify({ ven_amount: "200", currency: "USD", fiat_amount: "21.40", needs_approval: false }), { status: 200 });
    }

    if (url.host === "zeke.hubculture.test") {
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "PASS", checks: [], capabilities: state.zekeReadOnly ? ["read_only"] : [] }), { status: 200 });
      }
      const body = JSON.parse(call.body!);
      expect(headers.authorization).toBe("Bearer zeketoken");
      if (state.zekeReadOnly) {
        expect(body.data.hub_auth).toMatch(/\./); // the caller's context...
        expect(body.data.read_only).toBe(true); // ...with Zeke's own Ven sending switched off
      } else {
        expect(body.data.hub_auth).toBeUndefined(); // an older Zeke could send Ven with the token
      }
      const sse = [
        `data: {"event": "start", "thread_id": "t-1"}`,
        `data: {"event": "node_complete", "node": "vss_events_tool_node", "content": "tool output"}`,
        `data: {"event": "node_complete", "node": "agent", "content": "Ven is Hub Culture's digital currency."}`,
      ].join("\n\n");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    PUBLIC_URL,
    HUBID_URL: "https://id.hubculture.test",
    HUBID_CLIENT_ID: "77",
    HUBID_PUBLIC_KEY: "pub",
    HUBID_PRIVATE_KEY: "priv",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    PAYMENTS_URL: "https://pay.hubculture.test",
    PAYMENTS_SHARED_SECRET: "paysecret",
    ZEKE_URL: "https://zeke.hubculture.test",
    ZEKE_SYSTEM_TOKEN: "zeketoken",
    VEN_SEND_PER_TX: "100",
    VEN_SEND_PER_DAY: "120",
    ...overrides,
  });
}

/** Runs the whole sign-in the way claude.ai does: register, authorize (PKCE), consent, HubID, token. */
async function signIn(app: ReturnType<typeof createApp>, hubJwt: string, scope?: string) {
  const reg = await request(app).post("/register").send({ redirect_uris: [REDIRECT], client_name: "Claude", token_endpoint_auth_method: "none" });
  expect(reg.status).toBe(201);
  const clientId = reg.body.client_id;

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const auth = await request(app)
    .get("/authorize")
    .query({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "claude-state", resource: `${PUBLIC_URL}/mcp`, ...(scope ? { scope } : {}) });
  expect(auth.status).toBe(200);
  expect(auth.text).toContain("Connect Claude to Hub Culture");
  expect(auth.headers["x-frame-options"]).toBe("DENY");
  const pending = /name="pending" value="([^"]+)"/.exec(auth.text)![1];

  const consent = await request(app).post("/consent").type("form").send({ pending, decision: "member" });
  expect(consent.status).toBe(302);
  const hubUrl = new URL(consent.headers.location);
  expect(hubUrl.origin + hubUrl.pathname).toBe("https://id.hubculture.test/oauth/authorization");
  expect(hubUrl.searchParams.get("client_id")).toBe("77");
  expect(hubUrl.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/hubid/callback`);

  const callback = await request(app).get("/hubid/callback").query({ access_token: hubJwt, token_type: "jwt", state: hubUrl.searchParams.get("state") });
  expect(callback.status).toBe(302);
  const back = new URL(callback.headers.location);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("claude-state");
  expect(back.search).not.toContain(hubJwt);

  const token = await request(app)
    .post("/token")
    .type("form")
    .send({ grant_type: "authorization_code", code: back.searchParams.get("code"), code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: `${PUBLIC_URL}/mcp` });
  expect(token.status).toBe(200);
  return { clientId, ...token.body } as { clientId: string; access_token: string; refresh_token: string; scope: string };
}

function mcp(app: ReturnType<typeof createApp>, accessToken: string, method: string, params: unknown = {}) {
  return request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${accessToken}`)
    .set("Accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: 1, method, params });
}

const callTool = (app: ReturnType<typeof createApp>, token: string, name: string, args: unknown = {}) =>
  mcp(app, token, "tools/call", { name, arguments: args }).then((r) => {
    expect(r.status).toBe(200);
    return r.body.result as { isError?: boolean; content: { text: string }[] };
  });

describe("Hub Culture MCP server", () => {
  let app: ReturnType<typeof createApp>;
  let backends: ReturnType<typeof fakeBackends>;
  let state: { agentExchanges: number; zekeReadOnly: boolean };
  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    state = { agentExchanges: 0, zekeReadOnly: true };
    backends = fakeBackends(state);
    app = createApp(testConfig(), new MemoryStore(), backends.fetchImpl);
  });

  it("advertises OAuth metadata and asks for a token on /mcp", async () => {
    const meta = await request(app).get("/.well-known/oauth-authorization-server");
    expect(meta.body.authorization_endpoint).toBe(`${PUBLIC_URL}/authorize`);
    expect(meta.body.code_challenge_methods_supported).toContain("S256");
    const prm = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    expect(prm.body.resource).toBe(`${PUBLIC_URL}/mcp`);

    const res = await request(app).post("/mcp").send({});
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("resource_metadata");
  });

  it("refuses to register clients with redirect URIs outside the allowlist", async () => {
    const reg = await request(app).post("/register").send({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" });
    expect(reg.status).toBe(400);
    expect(redirectAllowed("http://localhost:6274/oauth/callback", testConfig().allowedRedirectUris)).toBe(true);
    expect(redirectAllowed("http://localhost.evil.example/cb", testConfig().allowedRedirectUris)).toBe(false);
  });

  it("signs in through HubID and calls tools as the member", async () => {
    const { access_token, scope } = await signIn(app, fakeJwt({ sub: 42, iat: now(), exp: now() + 86400 }));
    expect(scope.split(" ")).toEqual(expect.arrayContaining(["profile:read", "hubs:write", "ven:send", "ven:purchase", "zeke:ask"]));

    const list = await mcp(app, access_token, "tools/list");
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["hubid_get_profile", "hubs_post_discussion", "ven_send", "ven_purchase_quote", "ask_zeke"]));
    for (const tool of list.body.result.tools) {
      expect(tool.annotations.title).toBeTruthy(); // directory review: every tool has a title and a hint
      expect(tool.annotations.readOnlyHint === true || typeof tool.annotations.destructiveHint === "boolean").toBe(true);
    }
    expect(list.body.result.tools.find((t: { name: string }) => t.name === "ven_send").annotations.destructiveHint).toBe(true);

    const me = JSON.parse((await callTool(app, access_token, "hubid_get_profile")).content[0].text);
    expect(me).toMatchObject({ id: 42, name: "Jane Doe", ven_balance: 500, principal: "member" });
    expect(JSON.stringify(me)).not.toContain("SECRET");

    const friends = JSON.parse((await callTool(app, access_token, "hubid_list_friends")).content[0].text);
    expect(friends.items[0]).toEqual({ id: 7, name: "Sam", picture: "t.jpg" }); // no email or banking fields for others

    const quote = JSON.parse((await callTool(app, access_token, "ven_purchase_quote", { ven_amount: 200, currency: "usd" })).content[0].text);
    expect(quote.fiat_amount).toBe("21.40");

    const zeke = JSON.parse((await callTool(app, access_token, "ask_zeke", { message: "What is Ven?" })).content[0].text);
    expect(zeke).toEqual({ answer: "Ven is Hub Culture's digital currency.", thread_id: "t-1", caller_context: true });
    const followUp = await callTool(app, access_token, "ask_zeke", { message: "And how do I earn it?", thread_id: "t-1" });
    expect(followUp.isError).toBeFalsy();
    const foreign = await callTool(app, access_token, "ask_zeke", { message: "hi", thread_id: "someone-elses-thread" });
    expect(foreign.isError).toBe(true);

    const feed = JSON.parse((await callTool(app, access_token, "zeke_list_knowledge", { feed: "events", limit: 2 })).content[0].text);
    expect(feed).toEqual({ total: 3, items: [{ id: 1 }, { id: 2 }] });
  });

  it("asks an older Zeke without the caller's token, so it can't send Ven", async () => {
    state.zekeReadOnly = false;
    const { access_token } = await signIn(app, fakeJwt({ sub: 42, iat: now(), exp: now() + 86400 }));
    const zeke = JSON.parse((await callTool(app, access_token, "ask_zeke", { message: "What is Ven?" })).content[0].text);
    expect(zeke.caller_context).toBe(false);
    expect(zeke.answer).toBe("Ven is Hub Culture's digital currency.");
  });

  it("applies the member mandate: per-send cap, 24-hour cap, purpose and idempotency", async () => {
    const { access_token } = await signIn(app, fakeJwt({ sub: 42, iat: now(), exp: now() + 86400 }));
    const sends = () => backends.calls.filter((c) => c.url.pathname === "/transactions" && c.method === "POST").length;

    const missing = await callTool(app, access_token, "ven_send", { to_user_id: 7, amount: 5 });
    expect(missing.isError).toBe(true); // purpose and idempotency_key are required

    const tooMuch = await callTool(app, access_token, "ven_send", { to_user_id: 7, amount: 101, purpose: "dinner", idempotency_key: "k-too-much" });
    expect(tooMuch.content[0].text).toContain("at most 100 Ven");
    const badDecimals = await callTool(app, access_token, "ven_send", { to_user_id: 7, amount: 1.234, purpose: "dinner", idempotency_key: "k-decimals" });
    expect(badDecimals.isError).toBe(true);
    expect(sends()).toBe(0);

    const ok = JSON.parse((await callTool(app, access_token, "ven_send", { to_user_id: 7, amount: 100, purpose: "dinner", idempotency_key: "k-first-send" })).content[0].text);
    expect(ok).toMatchObject({ status: "sent", amount: 100, to: 7, balance_after: 400 });
    expect(JSON.parse(backends.calls.find((c) => c.url.pathname === "/transactions")!.body!).message).toBe("dinner");

    const retry = JSON.parse((await callTool(app, access_token, "ven_send", { to_user_id: 7, amount: 100, purpose: "dinner", idempotency_key: "k-first-send" })).content[0].text);
    expect(retry.replayed).toBe(true);
    expect(sends()).toBe(1); // the retry did not send again

    const overDay = await callTool(app, access_token, "ven_send", { to_user_id: 7, amount: 25, purpose: "lunch", idempotency_key: "k-second-send" });
    expect(overDay.content[0].text).toContain("120 Ven per 24 hours");
    expect(sends()).toBe(1);

    const balance = JSON.parse((await callTool(app, access_token, "ven_get_balance")).content[0].text);
    expect(balance.connector_mandate.remaining_24h).toBe(20);
  });

  it("connects an agent persona with its agent key, and routes its sends through the HubID mandate", async () => {
    const reg = await request(app).post("/register").send({ redirect_uris: [REDIRECT], client_name: "Claude", token_endpoint_auth_method: "none" });
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const auth = await request(app).get("/authorize").query({ response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
    const pending = /name="pending" value="([^"]+)"/.exec(auth.text)![1];

    const consent = await request(app).post("/consent").type("form").send({ pending, decision: "agent", agent_key: "agent-key-1" });
    expect(consent.status).toBe(302);
    const back = new URL(consent.headers.location);
    expect(back.origin + back.pathname).toBe(REDIRECT); // straight back to Claude: no HubID password page
    const token = await request(app).post("/token").type("form").send({ grant_type: "authorization_code", code: back.searchParams.get("code"), code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: REDIRECT });
    const access = token.body.access_token;

    const me = JSON.parse((await callTool(app, access, "hubid_get_profile")).content[0].text);
    expect(me).toMatchObject({ id: 654408, name: "Vela Lumen", principal: "agent" });

    const small = JSON.parse((await callTool(app, access, "ven_send", { to_user_id: 7, amount: 10, purpose: "tip", idempotency_key: "agent-send-1" })).content[0].text);
    expect(small.status).toBe("sent");
    const mandalaCall = backends.calls.find((c) => c.url.pathname === "/mandala/send")!;
    expect(mandalaCall.headers["idempotency-key"]).toBe("agent-send-1");
    expect(backends.calls.some((c) => c.url.pathname === "/transactions" && c.method === "POST")).toBe(false);

    const big = JSON.parse((await callTool(app, access, "ven_send", { to_user_id: 7, amount: 60, purpose: "supplies", idempotency_key: "agent-send-2" })).content[0].text);
    expect(big).toMatchObject({ status: "pending_approval", approval_id: 31 });
  });

  it("refuses an agent key HubID doesn't accept", async () => {
    const reg = await request(app).post("/register").send({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const auth = await request(app).get("/authorize").query({ response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256" });
    const pending = /name="pending" value="([^"]+)"/.exec(auth.text)![1];
    const consent = await request(app).post("/consent").type("form").send({ pending, decision: "agent", agent_key: "wrong" });
    expect(consent.status).toBe(400);
    expect(consent.text).toContain("agent key");
  });

  it("hides tools an admin disabled, and rate-limits writes per sign-in", async () => {
    app = createApp(testConfig({ DISABLED_TOOLS: "ven_send", RATE_LIMIT_WRITE_PER_MINUTE: "2" }), new MemoryStore(), backends.fetchImpl);
    const { access_token } = await signIn(app, fakeJwt({ sub: 42, iat: now(), exp: now() + 86400 }));
    const names = (await mcp(app, access_token, "tools/list")).body.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("ven_send");

    for (let i = 0; i < 2; i++) await callTool(app, access_token, "hubid_set_status", { message: `status ${i}` });
    const third = await callTool(app, access_token, "hubid_set_status", { message: "status 3" });
    expect(third.isError).toBe(true);
    expect(third.content[0].text).toContain("Rate limit");
  });

  it("only exposes tools for the scopes the member granted", async () => {
    const { access_token } = await signIn(app, fakeJwt({ sub: 42, iat: now(), exp: now() + 86400 }), "profile:read hubs:read");
    const names = (await mcp(app, access_token, "tools/list")).body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("hubid_get_profile");
    expect(names).toContain("hubs_list");
    expect(names).not.toContain("ven_get_balance");
    expect(names).not.toContain("ven_send");
    expect(names).not.toContain("messages_send");
    expect(names).not.toContain("ask_zeke");
  });

  it("refreshes the HubID JWT when it is about to expire, and rotates refresh tokens", async () => {
    const { access_token, refresh_token, clientId } = await signIn(app, fakeJwt({ sub: 42, iat: now() - 3600, exp: now() + 60 }));
    await callTool(app, access_token, "ven_get_balance");
    expect(backends.calls.filter((c) => c.url.pathname === "/token" && c.method === "PUT")).toHaveLength(1);
    await callTool(app, access_token, "ven_get_balance");
    expect(backends.calls.filter((c) => c.url.pathname === "/token" && c.method === "PUT")).toHaveLength(1);

    const refreshed = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token, client_id: clientId });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(access_token);
    const reused = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token, client_id: clientId });
    expect(reused.status).toBe(400);
  });

  it("does not accept a sign-in past HubID's 14-day refresh window", async () => {
    const reg = await request(app).post("/register").send({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const auth = await request(app).get("/authorize").query({ response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    const pending = /name="pending" value="([^"]+)"/.exec(auth.text)![1];
    const consent = await request(app).post("/consent").type("form").send({ pending, decision: "member" });
    const state = new URL(consent.headers.location).searchParams.get("state");
    const oldJwt = fakeJwt({ sub: 42, iat: now() - 15 * 86400, exp: now() - 14 * 86400 });
    const cb = await request(app).get("/hubid/callback").query({ access_token: oldJwt, state });
    const code = new URL(cb.headers.location).searchParams.get("code");
    const token = await request(app).post("/token").type("form").send({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: REDIRECT });
    expect(token.status).toBe(400);
  });

  it("sends the member back with access_denied when they cancel, and consent links are single-use", async () => {
    const reg = await request(app).post("/register").send({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const auth = await request(app).get("/authorize").query({ response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s1" });
    const pending = /name="pending" value="([^"]+)"/.exec(auth.text)![1];
    const deny = await request(app).post("/consent").type("form").send({ pending, decision: "deny" });
    expect(new URL(deny.headers.location).searchParams.get("error")).toBe("access_denied");
    const again = await request(app).post("/consent").type("form").send({ pending, decision: "member" });
    expect(again.status).toBe(400);

    const forged = await request(app).get("/hubid/callback").query({ access_token: "x.y.z", state: pending });
    expect(forged.status).toBe(400);
  });
});

describe("Zeke stream parsing", () => {
  it("keeps the last non-tool answer", () => {
    expect(parseZekeStream('data: {"event": "start", "thread_id": "a"}\n\ndata: {"event": "node_complete", "node": "x", "content": "hi"}')).toEqual({ answer: "hi", threadId: "a" });
  });
});
