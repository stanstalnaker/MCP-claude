import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Config, Scope } from "./config.js";
import { decrypt, encrypt, jwtClaims } from "./crypto.js";
import { grantTtl, type Grant, type Principal } from "./oauth/provider.js";
import type { HubIdClient } from "./services/hubid.js";
import type { Store } from "./store.js";

const REFRESH_MARGIN = 5 * 60;
// HubID's /mandala/v1 refuses agent JWTs older than MANDALA_TOKEN_MAX_AGE (60 min by default).
const AGENT_TOKEN_MAX_AGE = 50 * 60;

export class AuthRequiredError extends Error {}

/** The signed-in member or agent behind one MCP request. */
export type HubSession = {
  principal: Principal;
  hubUserId: number;
  grantId: string;
  scopes: Scope[];
  /** A HubID JWT valid for at least a few more minutes, refreshed through HubID if needed. */
  hubJwt(): Promise<string>;
};

export function sessionFromAuth(auth: AuthInfo | undefined, deps: { config: Config; store: Store; hubid: HubIdClient }): HubSession {
  const grantId = auth?.extra?.grantId;
  if (!auth || typeof grantId !== "string") throw new AuthRequiredError("Not signed in");
  return {
    principal: auth.extra?.principal === "agent" ? "agent" : "member",
    hubUserId: Number(auth.extra?.hubUserId),
    grantId,
    scopes: auth.scopes as Scope[],
    hubJwt: () => freshHubJwt(grantId, deps),
  };
}

async function freshHubJwt(grantId: string, { config, store, hubid }: { config: Config; store: Store; hubid: HubIdClient }): Promise<string> {
  const grant = await store.get<Grant>(`grant:${grantId}`);
  if (!grant) throw new AuthRequiredError("Your Hub Culture sign-in has expired. Reconnect the connector.");
  const key = config.tokenEncryptionKey;
  const jwt = decrypt(key, grant.hubJwt);
  const now = Math.floor(Date.now() / 1000);
  const claims = jwtClaims(jwt);

  let fresh: string;
  if (grant.principal === "agent") {
    const issued = Number((claims as { nbf?: number }).nbf ?? claims.iat ?? 0);
    if (now - issued < AGENT_TOKEN_MAX_AGE && grant.hubJwtExp - now > REFRESH_MARGIN) return jwt;
    fresh = await hubid
      .exchangeAgentKey(decrypt(key, grant.agentKey!))
      .then((r) => r.token)
      .catch(() => {
        throw new AuthRequiredError("This agent's key was revoked or has expired. The owner needs to reconnect it.");
      });
  } else {
    if (grant.hubJwtExp - now > REFRESH_MARGIN) return jwt;
    fresh = await hubid.refresh(jwt).catch(() => {
      throw new AuthRequiredError("Your Hub Culture sign-in has expired. Reconnect the connector.");
    });
  }

  grant.hubJwt = encrypt(key, fresh);
  grant.hubJwtExp = jwtClaims(fresh).exp ?? now + 24 * 60 * 60;
  await store.set(`grant:${grantId}`, grant, grantTtl(grant));
  return fresh;
}
