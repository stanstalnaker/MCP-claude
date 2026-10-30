import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ALL_SCOPES, type Config } from "./config.js";
import { HubOAuthProvider, setPageHeaders } from "./oauth/provider.js";
import { renderErrorPage } from "./oauth/pages.js";
import { HubIdClient } from "./services/hubid.js";
import { PaymentsClient } from "./services/payments.js";
import { ZekeClient } from "./services/zeke.js";
import { sessionFromAuth } from "./session.js";
import type { Store } from "./store.js";
import { registerHubTools } from "./tools/hub.js";
import { registerVenTools } from "./tools/ven.js";
import { registerZekeTools } from "./tools/zeke.js";

export const SERVER_INFO = { name: "hub-culture", version: "0.1.0" };

const INSTRUCTIONS = `Tools for Hub Culture, acting as the signed-in HubID member.
- hub_* tools cover the member's profile, people, friends, hubs, events, pavilions and private messages.
- ven_* tools cover the Ven wallet, Ven rates and buying Ven. ven_send moves real value: always confirm recipient and amount with the user before calling it.
- zeke_ask asks Zeke, Hub Culture's own assistant, which knows Hub Culture's news, events and pavilions.
Look people up with hub_search_users or hub_list_friends to get the user id other tools need.`;

export function createApp(config: Config, store: Store, fetchImpl: typeof fetch = fetch) {
  const hubid = new HubIdClient(config.hubid.url, config.hubid, fetchImpl);
  const payments = config.payments ? new PaymentsClient(config.payments.url, config.payments.sharedSecret, fetchImpl) : undefined;
  const zeke = config.zeke ? new ZekeClient(config.zeke.url, config.zeke.systemToken, fetchImpl) : undefined;
  const provider = new HubOAuthProvider(config, store);

  const mcpUrl = new URL("/mcp", config.publicUrl);
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.type("text").send("ok");
  });

  // OAuth 2.1 authorization server: metadata, /register, /authorize, /token, /revoke.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: ALL_SCOPES,
      resourceName: "Hub Culture",
      serviceDocumentationUrl: new URL("https://developers.hubculture.com"),
      // Claude keeps a registered client for a long time; don't expire its secret under it.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  app.post("/consent", express.urlencoded({ extended: false, limit: "4kb" }), async (req: Request, res: Response) => {
    setPageHeaders(res);
    try {
      const pending = String(req.body?.pending ?? "");
      const location = await provider.handleConsent(pending, req.body?.decision === "approve");
      res.redirect(302, location);
    } catch (err) {
      res.status(400).type("html").send(renderErrorPage(oauthMessage(err)));
    }
  });

  // HubID's OAuth sends the user back here with ?access_token=<HubID JWT>&state=...
  app.get("/hubid/callback", async (req: Request, res: Response) => {
    setPageHeaders(res);
    try {
      const q = req.query as Record<string, string | undefined>;
      const location = await provider.handleHubCallback(
        { state: q.state, access_token: q.access_token, error: q.error },
        (jwt) => hubid.getMe(jwt),
      );
      res.redirect(302, location);
    } catch (err) {
      res.status(400).type("html").send(renderErrorPage(oauthMessage(err)));
    }
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });

  // Stateless Streamable HTTP: a fresh server per request, with tools filtered to the token's scopes.
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    const session = sessionFromAuth(req.auth, { config, store, hubid });
    const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    const deps = { config, session, hubid, payments, zeke, fetchImpl };
    registerHubTools(server, deps);
    registerVenTools(server, deps);
    registerZekeTools(server, deps);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("mcp request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

function oauthMessage(err: unknown): string {
  if (err instanceof OAuthError) return err.message;
  console.error("sign-in error:", err);
  return "Something went wrong while signing in to Hub Culture. Start again from Claude.";
}
