import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Config, Scope } from "./config.js";
import { decrypt, encrypt, jwtClaims } from "./crypto.js";
import type { Grant } from "./oauth/provider.js";
import { HUBID_REFRESH_WINDOW } from "./oauth/provider.js";
import type { HubIdClient } from "./services/hubid.js";
import type { Store } from "./store.js";

const REFRESH_MARGIN = 5 * 60;

export class AuthRequiredError extends Error {}

/** The signed-in Hub Culture user behind one MCP request. */
export type HubSession = {
  hubUserId: number;
  scopes: Scope[];
  /** A HubID JWT valid for at least a few more minutes, refreshed through HubID if needed. */
  hubJwt(): Promise<string>;
};

export function sessionFromAuth(auth: AuthInfo | undefined, deps: { config: Config; store: Store; hubid: HubIdClient }): HubSession {
  const grantId = auth?.extra?.grantId;
  if (!auth || typeof grantId !== "string") throw new AuthRequiredError("Not signed in");
  return {
    hubUserId: Number(auth.extra?.hubUserId),
    scopes: auth.scopes as Scope[],
    hubJwt: () => freshHubJwt(grantId, deps),
  };
}

async function freshHubJwt(grantId: string, { config, store, hubid }: { config: Config; store: Store; hubid: HubIdClient }): Promise<string> {
  const grant = await store.get<Grant>(`grant:${grantId}`);
  if (!grant) throw new AuthRequiredError("Your Hub Culture sign-in has expired. Reconnect the connector.");
  const jwt = decrypt(config.tokenEncryptionKey, grant.hubJwt);
  const now = Math.floor(Date.now() / 1000);
  if (grant.hubJwtExp - now > REFRESH_MARGIN) return jwt;

  const refreshed = await hubid.refresh(jwt).catch(() => {
    throw new AuthRequiredError("Your Hub Culture sign-in has expired. Reconnect the connector.");
  });
  grant.hubJwt = encrypt(config.tokenEncryptionKey, refreshed);
  grant.hubJwtExp = jwtClaims(refreshed).exp ?? now + 24 * 60 * 60;
  await store.set(`grant:${grantId}`, grant, grant.hubLoginAt + HUBID_REFRESH_WINDOW - now);
  return refreshed;
}
