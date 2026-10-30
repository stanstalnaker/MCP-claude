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
function fakeBackends(state: { jwtExp: number }) {
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
      expect(headers["private-key"]).toBe("priv");
      expect(headers.authorization).toMatch(/^Bearer /);
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
      const body = JSON.parse(call.body!);
      expect(headers.authorization).toBe("Bearer zeketoken");
      expect(body.data.hub_auth).toMatch(/\./);
      const sse = [
        `data: {"event": "start", "thread_id": "t-1"}`,
        `data: {"event": "node_complete", "node": "vss_events_tool_node", "content": "tool output"}`,
        `data: {"event": "node_complete", "node": "agent", "content": "Ven is Hub Culture's digital currency."}`,
      ].join("\n\n");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  void state;
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
    MAX_VEN_PER_TRANSFER: "100",
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

  const consent = await request(app).post("/consent").type("form").send({ pending, decision: "approve" });
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
  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    backends = fakeBackends({ jwtExp: 0 });
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
    expect(scope.split(" ")).toEqual(expect.arrayContaining(["read", "write", "ven:transfer", "ven:purchase", "zeke"]));

    const list = await mcp(app, access_token, "tools/list");
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["hub_get_me", "ven_send", "ven_purchase_quote", "zeke_ask"]));
    expect(list.body.result.tools.find((t: { name: string }) => t.name === "ven_send").annotations.destructiveHint).toBe(true);

    const me = JSON.parse((await callTool(app, access_token, "hub_get_me")).content[0].text);
    expect(me).toMatchObject({ id: 42, name: "Jane Doe", ven_balance: 500 });
    expect(JSON.stringify(me)).not.toContain("SECRET");

    const friends = JSON.parse((await callTool(app, access_token, "hub_list_friends")).content[0].text);
    expect(friends.items[0]).toEqual({ id: 7, name: "Sam", picture: "t.jpg" }); // no email or banking fields for others

    const quote = JSON.parse((await callTool(app, access_token, "ven_purchase_quote", { ven_amount: 200, currency: "usd" })).content[0].text);
    expect(quote.fiat_amount).toBe("21.40");

    const zeke = JSON.parse((await callTool(app, access_token, "zeke_ask", { message: "What is Ven?" })).content[0].text);
    expect(zeke).toEqual({ answer: "Ven is Hub Culture's digital currency.", thread_id: "t-1" });

    const feed = JSON.parse((await callTool(app, access_token, "zeke_list_knowledge", { feed: "events", limit: 2 })).content[0].text);
    expect(feed).toEqual({ total: 3, items: [{ id: 1 }, { id: 2 }] });
  });

  it("enforces the per-transfer Ven cap before calling HubID", async () => {
    const { access_token } = await signIn(app, fakeJwt({ sub: 42, iat: now(), exp: now() + 86400 }));
    const tooMuch = await callTool(app, access_token, "ven_send", { to_user_id: 7, amount: 101 });
    expect(tooMuch.isError).toBe(true);
    expect(tooMuch.content[0].text).toContain("at most 100 Ven");
    expect(backends.calls.some((c) => c.url.pathname === "/transactions")).toBe(false);

    const badDecimals = await callTool(app, access_token, "ven_send", { to_user_id: 7, amount: 1.234 });
    expect(badDecimals.isError).toBe(true);

    const ok = JSON.parse((await callTool(app, access_token, "ven_send", { to_user_id: 7, amount: 25, message: "thanks" })).content[0].text);
    expect(ok).toMatchObject({ sent: true, amount: 25, to: 7, balance_after: 475 });
  });

  it("only exposes tools for the scopes the member granted", async () => {
    const { access_token } = await signIn(app, fakeJwt({ sub: 42, iat: now(), exp: now() + 86400 }), "read");
    const names = (await mcp(app, access_token, "tools/list")).body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("hub_get_me");
    expect(names).not.toContain("ven_send");
    expect(names).not.toContain("hub_send_message");
    expect(names).not.toContain("zeke_ask");
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
    const consent = await request(app).post("/consent").type("form").send({ pending, decision: "approve" });
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
    const again = await request(app).post("/consent").type("form").send({ pending, decision: "approve" });
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
