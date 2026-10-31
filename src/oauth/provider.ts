import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ALL_SCOPES, SCOPES, type Config, type Scope } from "../config.js";
import { encrypt, hashToken, jwtClaims, randomToken } from "../crypto.js";
import type { Store } from "../store.js";
import { renderConsentPage } from "./pages.js";

// This server is its own OAuth 2.1 authorization server (what claude.ai and other MCP clients
// expect: metadata discovery, dynamic client registration, PKCE), because HubID's own sign-in
// is an implicit-style flow that returns a JWT. Identity still comes from HubID, for two kinds
// of principal (PRD "Two kinds of principal"):
//   member: our consent page → HubID /oauth/authorization → /hubid/callback with the member's JWT
//   agent:  the owner pastes the agent's Mandala agent key on our consent page → /mandala/key/token
// Either way we issue our own code and tokens bound to that identity. Clients never see a HubID
// JWT or the agent key.

export const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
const PENDING_TTL = 10 * 60;
const CODE_TTL = 5 * 60;
// HubID lets a JWT be refreshed for 14 days after the original login; after that the user signs in again.
export const HUBID_REFRESH_WINDOW = 14 * 24 * 60 * 60;

export type PendingAuthorization = {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: Scope[];
  resource?: string;
  approved?: boolean;
};

export type Principal = "member" | "agent";

export type Grant = {
  principal: Principal;
  clientId: string;
  scopes: Scope[];
  resource?: string;
  hubUserId: number;
  hubUserName?: string;
  hubJwt: string; // encrypted
  hubJwtExp: number;
  hubLoginAt: number; // members: iat of the original HubID token, which bounds refresh
  agentKey?: string; // agents: encrypted Mandala agent key, re-exchanged for fresh JWTs
  expiresAt: number;
};

type CodeRecord = { grantId: string; clientId: string; redirectUri: string; codeChallenge: string };
type TokenRecord = { grantId: string; clientId: string; expiresAt: number };

export class HubOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {
    this.clientsStore = {
      getClient: (clientId) => store.get<OAuthClientInformationFull>(`client:${clientId}`),
      registerClient: async (client) => {
        for (const uri of client.redirect_uris) {
          if (!redirectAllowed(String(uri), config.allowedRedirectUris)) {
            throw new InvalidClientMetadataError(`redirect_uri not allowed: ${uri}`);
          }
        }
        const full = client as OAuthClientInformationFull;
        await store.set(`client:${full.client_id}`, full);
        return full;
      },
    };
  }

  /** Step 1: show our consent page, naming the client and what it will be able to do. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const scopes = resolveScopes(params.scopes, this.config.defaultScopes);
    const pendingId = randomToken();
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes,
      // Clients that don't send RFC 8707 `resource` still get a token for this server's /mcp.
      resource: (params.resource ?? new URL("/mcp", this.config.publicUrl)).href,
    };
    await this.store.set(`pending:${pendingId}`, pending, PENDING_TTL);
    setPageHeaders(res);
    res.status(200).type("html").send(
      renderConsentPage({
        pendingId,
        clientName: client.client_name ?? "An MCP client",
        redirectHost: safeHost(params.redirectUri),
        scopes: scopes.map((s) => SCOPES[s]),
      }),
    );
  }

  /**
   * Step 2 (POST /consent). "member" → off to HubID's sign-in; "agent" → exchange the pasted agent
   * key and finish here; "deny" → back to the client with access_denied.
   */
  async handleConsent(
    pendingId: string,
    decision: "member" | "agent" | "deny",
    hub: HubIdentity,
    agentKey?: string,
  ): Promise<string> {
    const pending = await this.store.take<PendingAuthorization>(`pending:${pendingId}`);
    if (!pending || pending.approved) throw new InvalidGrantError("This sign-in link has expired. Start again from Claude.");
    if (decision === "deny") return withParams(pending.redirectUri, { error: "access_denied", state: pending.state });

    if (decision === "agent") {
      const key = agentKey?.trim();
      if (!key) throw new InvalidGrantError("Paste the agent's key to connect it.");
      const { token } = await hub.exchangeAgentKey(key).catch(() => {
        throw new InvalidGrantError("HubID didn't accept that agent key. Check it hasn't been revoked, then start again from Claude.");
      });
      return this.completeAuthorization(pending, "agent", token, await hub.getMe(token), key);
    }

    const hubState = randomToken();
    await this.store.set(`pending:${hubState}`, { ...pending, approved: true }, PENDING_TTL);
    const url = new URL(`${this.config.hubid.url}/oauth/authorization`);
    url.searchParams.set("response_type", "token");
    url.searchParams.set("client_id", this.config.hubid.clientId);
    url.searchParams.set("redirect_uri", new URL("/hubid/callback", this.config.publicUrl).href);
    url.searchParams.set("state", hubState);
    url.searchParams.set("sitename", "Hub Culture for Claude");
    return url.href;
  }

  /** Step 3 (GET /hubid/callback): HubID sent the user back with a JWT. Issue our authorization code. */
  async handleHubCallback(params: { state?: string; access_token?: string; error?: string }, hub: HubIdentity): Promise<string> {
    const pending = params.state ? await this.store.take<PendingAuthorization>(`pending:${params.state}`) : undefined;
    if (!pending?.approved) throw new InvalidGrantError("This sign-in link has expired. Start again from Claude.");
    if (params.error || !params.access_token) {
      return withParams(pending.redirectUri, { error: "access_denied", state: pending.state });
    }

    // getMe proves the token works and tells us who signed in.
    return this.completeAuthorization(pending, "member", params.access_token, await hub.getMe(params.access_token));
  }

  private async completeAuthorization(
    pending: PendingAuthorization,
    principal: Principal,
    hubJwt: string,
    me: { id: number; name?: string },
    agentKey?: string,
  ): Promise<string> {
    const claims = jwtClaims(hubJwt);
    const now = nowSeconds();
    const loginAt = claims.iat ?? now;
    const key = this.config.tokenEncryptionKey;
    const grantId = randomToken();
    const grant: Grant = {
      principal,
      clientId: pending.clientId,
      scopes: pending.scopes,
      resource: pending.resource,
      hubUserId: Number(me.id),
      hubUserName: me.name,
      hubJwt: encrypt(key, hubJwt),
      hubJwtExp: claims.exp ?? now + 24 * 60 * 60,
      hubLoginAt: loginAt,
      agentKey: agentKey ? encrypt(key, agentKey) : undefined,
      // Members are bounded by HubID's 14-day refresh window; agents re-exchange their key until it's revoked.
      expiresAt: principal === "agent" ? now + this.config.agentGrantDays * 24 * 60 * 60 : loginAt + HUBID_REFRESH_WINDOW,
    };
    await this.store.set(`grant:${grantId}`, grant, grantTtl(grant));

    const code = randomToken();
    const record: CodeRecord = {
      grantId,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
    };
    await this.store.set(`code:${hashToken(code)}`, record, CODE_TTL);
    return withParams(pending.redirectUri, { code, state: pending.state });
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const record = await this.store.get<CodeRecord>(`code:${hashToken(code)}`);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string, // checked by the SDK against challengeForAuthorizationCode
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = await this.store.take<CodeRecord>(`code:${hashToken(code)}`);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    if (redirectUri && redirectUri !== record.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    const grant = await this.store.get<Grant>(`grant:${record.grantId}`);
    if (!grant) throw new InvalidGrantError("Sign-in expired");
    return this.issueTokens(record.grantId, grant);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const record = await this.store.take<TokenRecord>(`refresh:${hashToken(refreshToken)}`); // rotated on every use
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    const grant = await this.store.get<Grant>(`grant:${record.grantId}`);
    if (!grant) throw new InvalidGrantError("Sign-in expired; sign in to Hub Culture again");
    if (scopes?.length) {
      const narrowed = scopes.filter((s): s is Scope => (grant.scopes as string[]).includes(s));
      if (narrowed.length !== scopes.length) throw new InvalidScopeError("Cannot widen scopes on refresh");
      grant.scopes = narrowed;
      await this.store.set(`grant:${record.grantId}`, grant, grantTtl(grant));
    }
    return this.issueTokens(record.grantId, grant);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.get<TokenRecord>(`access:${hashToken(token)}`);
    if (!record || record.expiresAt <= nowSeconds()) throw new InvalidTokenError("Invalid or expired token");
    const grant = await this.store.get<Grant>(`grant:${record.grantId}`);
    if (!grant) throw new InvalidTokenError("Sign-in expired");
    return {
      token,
      clientId: record.clientId,
      scopes: grant.scopes,
      expiresAt: record.expiresAt,
      resource: grant.resource ? new URL(grant.resource) : undefined,
      extra: { grantId: record.grantId, hubUserId: grant.hubUserId, principal: grant.principal },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = hashToken(request.token);
    for (const kind of ["access", "refresh"]) {
      const record = await this.store.get<TokenRecord>(`${kind}:${hash}`);
      if (record && record.clientId === client.client_id) {
        await this.store.del(`${kind}:${hash}`);
        if (kind === "refresh") await this.store.del(`grant:${record.grantId}`); // ends the whole sign-in
      }
    }
  }

  private async issueTokens(grantId: string, grant: Grant): Promise<OAuthTokens> {
    const now = nowSeconds();
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const refreshTtl = grantTtl(grant);
    if (refreshTtl <= 0) throw new InvalidGrantError("Sign-in expired; sign in to Hub Culture again");
    await this.store.set<TokenRecord>(
      `access:${hashToken(accessToken)}`,
      { grantId, clientId: grant.clientId, expiresAt: now + ACCESS_TOKEN_TTL },
      ACCESS_TOKEN_TTL,
    );
    await this.store.set<TokenRecord>(
      `refresh:${hashToken(refreshToken)}`,
      { grantId, clientId: grant.clientId, expiresAt: now + refreshTtl },
      refreshTtl,
    );
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
      scope: grant.scopes.join(" "),
    };
  }
}

export function resolveScopes(requested: string[] | undefined, defaults: Scope[]): Scope[] {
  if (!requested?.length) return [...defaults];
  const unknown = requested.filter((s) => !(ALL_SCOPES as string[]).includes(s));
  if (unknown.length) throw new InvalidScopeError(`Unknown scope: ${unknown.join(", ")}`);
  return [...new Set(requested as Scope[])];
}

/** Exact match, or `scheme://host:*` to allow any port (loopback redirects for local clients). */
export function redirectAllowed(uri: string, patterns: string[]): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return patterns.some((pattern) => {
    if (pattern.endsWith(":*")) {
      const base = new URL(pattern.slice(0, -2));
      return url.protocol === base.protocol && url.hostname === base.hostname;
    }
    return uri === pattern;
  });
}

export function grantTtl(grant: Grant): number {
  return grant.expiresAt - nowSeconds();
}

/** The HubID calls sign-in needs; HubIdClient provides them. */
export type HubIdentity = {
  getMe(jwt: string): Promise<{ id: number; name?: string }>;
  exchangeAgentKey(agentKey: string): Promise<{ token: string }>;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
  return url.href;
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export function setPageHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
}
