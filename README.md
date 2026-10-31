# hub-mcp: the Hub Culture connector for Claude

A remote MCP server that lets Claude act on the Hub Culture network through HubID. It acts either as a signed-in member or as an agent persona (such as Vela Lumen) under its owner's HubID. It covers profiles, friends, hubs, discussions, events, pavilions and messages; Ven prices, the wallet and purchases; and Zeke.

It implements phase 1 of the PRD, [Hub Culture Connector for Claude](https://claude.ai/artifact/Bwp6E8E2YyH3PNFsZ6QvPn). Its Implementation status section tracks what is built, what changed, and what still waits on other teams.

Add it in Claude under **Settings → Connectors → Add custom connector** with `https://<your host>/mcp`. In Claude Code, run `claude mcp add --transport http hub-culture https://<your host>/mcp`.

## How sign-in works

```
Claude ──/authorize (PKCE)──▶ hub-mcp consent page
   member: ──▶ HubID /oauth/authorization ──▶ /hubid/callback?access_token=<HubID JWT>
   agent:  owner pastes the agent's Mandala agent key ──▶ HubID /mandala/key/token
Claude ◀──code── hub-mcp          Claude ──/token──▶ opaque access + refresh tokens
Claude ──/mcp + Bearer──▶ hub-mcp ──Private-Key + the principal's JWT──▶ HubID / payments
```

- **hub-mcp is its own OAuth 2.1 server.** It provides metadata discovery, dynamic client registration, PKCE (S256), refresh-token rotation and revocation. HubID's own sign-in is implicit-style and returns a JWT, so hub-mcp wraps it until HubID offers OAuth 2.1 itself.
- **Two kinds of principal, as in the PRD.**
  - **Members** sign in with HubID. Their JWT refreshes for 14 days after a login, so they reconnect every 14 days.
  - **Agents** connect with a Mandala agent key, which the owner issues and can revoke in HubID; no password is involved. hub-mcp re-exchanges the key for a fresh JWT every 50 minutes, the most `/mandala/v1` allows. A sign-in lasts `AGENT_GRANT_DAYS`.
- **Clients never see a HubID JWT or an agent key.** Both are stored encrypted (AES-256-GCM), and tokens are stored only as hashes.
- **Only allow-listed redirect URIs can register.** By default those are Claude's callbacks and loopback addresses (`ALLOWED_REDIRECT_URIS`).

## Scopes and tools

A token only lists the tools its scopes allow, minus any in `DISABLED_TOOLS`. claude.ai asks for no specific scopes, so it gets `DEFAULT_SCOPES`.

| Scope | Tools |
|---|---|
| `profile:read` | `hubid_get_profile`, `hubid_search`, `hubid_list_friends`, `hubid_list_friend_requests` |
| `hubid:write` | `hubid_set_status`, `hubid_send_friend_request`, `hubid_answer_friend_request` |
| `hubs:read` | `hubs_list`, `hubs_get`, `hubs_list_members`, `hubs_read_discussions`, `hubs_list_events`, `hubs_get_event`, `hubs_list_pavilions`, `hubs_get_pavilion`, `zeke_list_knowledge` |
| `hubs:write` | `hubs_post_discussion`, `hubs_create_event` |
| `messages:read` | `messages_list`, `messages_get_thread`, `messages_list_alerts` |
| `messages:send` | `messages_send`, `messages_reply` |
| `ven:read` | `ven_get_price`, `ven_get_rate_history`, `ven_get_supply_stats`, `ven_get_balance`, `ven_list_transactions`, `ven_get_transaction`, `ven_purchase_quote`\*, `ven_list_purchase_orders`\* |
| `ven:request` | `ven_request` |
| `ven:send` | `ven_send` |
| `ven:purchase` | `ven_create_purchase_order`\*: returns a `payment_url`; nothing is charged until the member pays there |
| `zeke:ask` | `ask_zeke`\*\* |

\* Only when `PAYMENTS_URL` is set. \*\* Only when `ZEKE_URL` is set.

## Safety

- **Ven mandate.** `ven_send` requires a `purpose` and an `idempotency_key`. A retry with the same key returns the first result instead of sending twice.
  - **Agents** send through HubID's `/mandala/send`. There the owner's custodian policy applies: per-send cap, rolling-window cap, recipient allowlist and approval threshold. A large send comes back as `pending_approval` for the owner to confirm. HubID only enforces this with `MANDALA_ENFORCE_VEN_SEND=true`.
  - **Members** send through `/transactions`, which has no mandate, so hub-mcp enforces `VEN_SEND_PER_TX` and `VEN_SEND_PER_DAY` over a rolling 24 hours.
  - **Both** stay under the connector caps, which act as a ceiling.
- **Idempotency elsewhere.** `ven_request` also requires an `idempotency_key`. Posting and messaging tools accept an optional one.
- **Audit.** Every write logs one JSON `audit` line: SHA-256 hashes of the principal, tool, arguments and result, plus a timestamp. Forwarding these to OAI.io waits on OAI.io's write API.
- **Rate limits** apply per sign-in: `RATE_LIMIT_READ_PER_MINUTE` and `RATE_LIMIT_WRITE_PER_MINUTE`.
- **Kill switches.** `DISABLED_TOOLS` turns off a tool for everyone. Revoking an agent key cuts off that agent within the hour, the next time hub-mcp renews its token; revoking the connector's HubID app keys cuts off every call at once.
- **Data minimisation.** Other members come back with public basics only; emails, banking and profile fields are dropped. Private fields go only to their owner.
- **Zeke is read-only.** `ask_zeke` doesn't forward the caller's token. With it, Zeke's own send-Ven tool could move Ven outside the mandate. Zeke answers from Hub Culture's public knowledge.
- **No admin access.** The payments interchange is always called as role `buyer`.

## Services it calls

| Service | Repo | Auth |
|---|---|---|
| HubID API (`id.hubculture.com`) | hub/HubID | Connector app's `Private-Key`, plus the principal's JWT. `/mandala/*` takes only the agent's JWT. |
| Ven rates (`apilaravel.ven.vc`) | hub/Ven.vc-Core-Laravel | Public |
| Payments interchange | hub-culture/payments-interchange | HMAC-signed as Hub does (`X-Pay-*`), with the caller's id |
| Zeke (`/chat`) | hub-culture/zeke-ai-server | System bearer token; no user token |

## Setup

The go-live checklist, with owners and checks, is in [DEPLOY.md](DEPLOY.md).

## Development

```bash
npm install
npm test        # end-to-end: both sign-in paths, the mandate and tool calls against fake HubID, payments and Zeke
npm run dev     # needs a .env (or exported variables)
npx @modelcontextprotocol/inspector   # point it at http://localhost:8080/mcp
```
