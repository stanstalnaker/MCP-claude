# Going live: Hub Culture connector for Claude

The checklist for getting this server running and available in Claude. Work through it in order; each step says how to tell it's done.

## 0. Before anything else: fix HubID's redirect check

**Owner:** HubID dev.

**The problem.** HubID's `/oauth/authorization` doesn't check `redirect_uri` against the app named by `client_id`. Any link can therefore send a signed-in member's JWT to any address, and it does so silently for apps the member already approved and for the hubculture.com app. This connector uses that same sign-in flow.

**The fix**, in `hubid_api/app/Http/Controllers/OAuthController.php`:
- Refuse any `redirect_uri` that the app hasn't registered. Show an error page; never redirect.
- Apply the same check to `/oauth/authorization/status`.
- URL-encode `state` in the redirect.

**Done when:** a request with a foreign `redirect_uri` gets an error page and no token.

## 1. Register the connector as a HubID app

**Owner:** a Hub Culture admin.

1. In the apps admin at https://hubculture.com/admin/apps/, create an app:
   - **Title:** `Claude`. HubID shows this on its sign-in page.
   - **URL / callback:** `https://mcp.hubculture.com/hubid/callback`. Use the real host from step 2.
   - **Owner:** the admin account responsible for the connector.
2. Note the app's numeric **id**. That's `HUBID_CLIENT_ID`: HubID's `/oauth/authorization` looks the app up by `api_apps.id`.
3. Get a **public** and a **private** API key for the app. Don't reuse Zeke's or Hub's keys, so this connector can be revoked on its own.
   - If the admin page doesn't issue keys, a HubID dev adds one `public` and one `private` row to `hubapp.api_keys` instead.
   - Also confirm the page writes to `api_apps`, not the legacy `apps` table, which has `client_id`/`client_secret` columns. HubID's sign-in only checks `api_apps`.
4. Store the id and both keys in the secret manager. Never put them in Slack or Git.

**Done when:** both of these hold.
- `curl -H "Private-Key: <key>" https://id.hubculture.com/markets` stops returning `Wrong private api key`. With no JWT, a 401 token error is fine; that means the key itself was accepted.
- Opening `https://id.hubculture.com/oauth/authorization?response_type=token&client_id=<id>&redirect_uri=https://mcp.hubculture.com/hubid/callback` shows a sign-in page titled "Claude", not `error=unauthorized_client`.

## 2. Infrastructure

**Owner:** DevOps.

- **Host:** one HTTPS host, e.g. `mcp.hubculture.com`, with a valid TLS certificate. Claude only connects over HTTPS.
- **Redis:** any managed Redis. It holds sign-ins; without it, members have to reconnect after every restart.
- **Network:** the container needs outbound access to:
  - `id.hubculture.com`
  - `apilaravel.ven.vc`
  - the payments interchange (internal address)
  - Zeke (internal address)
- **Inbound:** expose port 8080 through the load balancer and health-check `/healthz`.

## 3. Configure

**Owner:** DevOps. Copy `.env.example` and fill it in.

| Variable | Value |
|---|---|
| `PUBLIC_URL` | `https://mcp.hubculture.com` |
| `HUBID_CLIENT_ID` / `HUBID_PUBLIC_KEY` / `HUBID_PRIVATE_KEY` | From step 1 |
| `TOKEN_ENCRYPTION_KEY` | Output of `openssl rand -base64 32`. Generate it once and keep it: changing it signs everyone out. |
| `REDIS_URL` | From step 2 |
| `PAYMENTS_URL` / `PAYMENTS_SHARED_SECRET` | The interchange's address and its `HUB_SHARED_SECRET`. Leave both empty to launch without the Ven-purchase tools. |
| `ZEKE_URL` / `ZEKE_SYSTEM_TOKEN` | zeke-ai-server's address and its system bearer token. Leave both empty to launch without `ask_zeke`. |
| `VEN_SEND_PER_TX` / `VEN_SEND_PER_DAY` | `100` / `500` Ven, unless the product owner decides otherwise. Members are held to these; agents are also held to their own HubID mandate. |
| `DEFAULT_SCOPES` | All scopes, as in `.env.example`. Remove `ven:send` to launch without Ven sending. |
| `DISABLED_TOOLS` | Empty. Name a tool here to turn it off for everyone. |

**In HubID**, set `MANDALA_ENFORCE_VEN_SEND=true`. Without it, HubID doesn't apply agents' custodian policies (caps, allowlist, owner approval); only the connector's caps would hold.

## 4. Build and deploy

```bash
git clone https://github.com/stanstalnaker/MCP-claude && cd MCP-claude
npm ci && npm test                  # all tests must pass
docker build -t hub-mcp .
docker run --env-file .env -p 8080:8080 hub-mcp
```

**Done when:** all three of these work.

```bash
curl https://mcp.hubculture.com/healthz                                        # -> ok
curl https://mcp.hubculture.com/.well-known/oauth-authorization-server         # -> JSON metadata
curl -i -X POST https://mcp.hubculture.com/mcp | grep -i www-authenticate      # -> 401 with resource_metadata
```

## 5. Test with a real account

**Owner:** any dev. Use a test HubID account holding a little Ven.

1. Connect with MCP Inspector (`npx @modelcontextprotocol/inspector`) or Claude Code:
   `claude mcp add --transport http hub-culture https://mcp.hubculture.com/mcp`
2. Sign in as a member. You should see the consent page, then HubID's login, then a return to the client.
3. Run each check:
   - `hubid_get_profile` returns your profile, with `principal: member`.
   - `hubid_list_friends` returns no emails or banking fields.
   - `ven_get_balance` returns your balance and the connector's remaining 24-hour allowance.
   - `ven_get_price` returns rates.
   - `ven_send` 1 Ven to a second test account, with a purpose and an idempotency key: the balance drops by 1.
   - The same call again with the same key returns `replayed` and the balance is unchanged.
   - `ven_send` 101 Ven is refused by the cap, and the balance is unchanged.
   - `ven_purchase_quote` with 200 USD returns a price (only if payments is configured).
   - `ask_zeke` with "What is Ven?" returns an answer (only if Zeke is configured).
4. Connect a test agent persona:
   - Issue it a Mandala agent key in HubID, and give it a custodian policy with a low approval threshold.
   - Connect again and choose **Connecting an agent persona instead?** on the consent page.
   - Check `hubid_get_profile` shows `principal: agent`.
   - A `ven_send` above the threshold returns `pending_approval`, and it shows in the owner's custodian approvals.
5. Reconnect after 24 hours, or set the stored JWT's expiry back, to confirm the HubID token refresh works.

**Done when:** every check above passes. Post the results in the thread.

## 6. Make it available in Claude

**Owner:** the Claude organization owner (Stan).

1. In claude.ai, go to **Settings → Connectors → Add custom connector**.
2. Enter the name `Hub Culture` and the URL `https://mcp.hubculture.com/mcp`. Leave the OAuth client ID/secret empty; the connector registers itself.
3. Add it at the organization level so every member gets it. Each person still signs in with their own HubID.
4. Optionally, in that connector's tool permissions, set `ven_send` and `ven_create_purchase_order` to "ask every time".

**Done when:** a member enables the connector in a chat, signs in, and asks "what's my Ven balance?" successfully.

## 7. After launch

- **Watch the logs** for `tool error:` and `sign-in error:` lines. Each write also logs one `audit` JSON line; ship these to log storage until OAI.io can take them.
- **Expect re-sign-ins:** HubID tokens only refresh for 14 days after a login, so members reconnect every two weeks. This is expected.
- **To cut off one tool,** add it to `DISABLED_TOOLS` and restart.
- **To cut off one agent,** revoke its agent key in HubID. It loses access within the hour, at its next token renewal.
- **To cut off the connector,** delete its `api_keys` rows. Every call fails at once.
- **When HubID routes change,** update the matching tool in `src/tools/`.
