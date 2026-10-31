# hub-mcp

A remote MCP server that lets Claude agents use Hub Culture as the signed-in member: profile, people, friends, hubs, events, pavilions and messages; the Ven wallet, rates and purchases; and Zeke.

Members add it in Claude under **Settings → Connectors → Add custom connector** with the URL `https://<your host>/mcp`, then sign in with their HubID. Claude Code works too: `claude mcp add --transport http hub-culture https://<your host>/mcp`.

## How sign-in works

```
Claude ──/authorize (PKCE)──▶ hub-mcp consent page ──▶ HubID /oauth/authorization
                                                           │ member signs in, approves
Claude ◀──code── hub-mcp /hubid/callback ◀──?access_token=<HubID JWT>
Claude ──/token──▶ hub-mcp access + refresh tokens (opaque)
Claude ──/mcp + Bearer──▶ hub-mcp ──Private-Key + member's JWT──▶ HubID / Zeke / payments
```

- **hub-mcp is its own OAuth 2.1 server.** It provides what MCP clients expect: metadata, dynamic client registration, PKCE (S256), refresh-token rotation and revocation.
- **HubID still owns identity.** Its sign-in flow is implicit-style and returns a JWT, so hub-mcp wraps it.
- **Clients never see the HubID JWT.** It's stored encrypted (AES-256-GCM), and tokens are stored only as hashes.
- **The HubID JWT is refreshed as needed** with `PUT /token`. HubID allows refreshes for 14 days after a login, so members sign in again every 14 days.
- **Only allow-listed redirect URIs can register.** By default those are Claude's callbacks and loopback addresses (`ALLOWED_REDIRECT_URIS`).
- **There's a consent page before HubID.** It names the client and lists what it will be able to do. HubID skips its own consent screen after the first approval.

## Scopes and tools

A token only lists the tools its scopes allow. claude.ai asks for no specific scopes, so it gets `DEFAULT_SCOPES` (all of them, by default).

| Scope | Tools |
|---|---|
| `read` | `hub_get_me`, `hub_get_user`, `hub_search_users`, `hub_list_friends`, `hub_list_friend_requests`, `hub_list_my_hubs`, `hub_get_hub`, `hub_list_hub_members`, `hub_list_hub_news`, `hub_list_events`, `hub_get_event`, `hub_list_pavilions`, `hub_get_pavilion`, `hub_list_messages`, `hub_get_thread`, `hub_list_alerts`, `ven_get_balance`, `ven_list_transactions`, `ven_get_transaction`, `ven_get_exchange_rates`, `ven_get_rate_history`, `ven_get_supply_stats`, `ven_purchase_quote`\*, `ven_list_purchase_orders`\*, `zeke_list_knowledge` |
| `write` | `hub_send_message`, `hub_reply_to_thread`, `hub_send_friend_request`, `hub_answer_friend_request`, `hub_post_to_hub_wall`, `hub_create_event`, `hub_set_status_message`, `ven_request` |
| `ven:transfer` | `ven_send`: marked destructive, capped by `MAX_VEN_PER_TRANSFER`, at most 2 decimals |
| `ven:purchase` | `ven_create_purchase_order`\*: returns a `payment_url`. Nothing is charged until the member pays there. |
| `zeke` | `zeke_ask`\*\* |

\* Only when `PAYMENTS_URL` is set. \*\* Only when `ZEKE_URL` is set.

- **Personal data is trimmed.** Other members come back with only their public basics. HubID's user objects also carry emails, banking and profile fields, and those are dropped.
- **No admin access.** The payments interchange is always called as role `buyer`, and no admin or moderation endpoints are exposed.

## Services it calls

| Service | Repo | Auth |
|---|---|---|
| HubID API (`id.hubculture.com`) | hub/HubID | Connector app's `Private-Key`, plus the member's JWT |
| Ven rates (`apilaravel.ven.vc`) | hub/Ven.vc-Core-Laravel | Public |
| Payments interchange | hub-culture/payments-interchange | HMAC-signed as Hub does (`X-Pay-*`), with the member's id |
| Zeke (`/chat`) | hub-culture/zeke-ai-server | System bearer token; the member's JWT goes in `data.hub_auth` |

## Setup

The full go-live checklist, with owners and checks, is in [DEPLOY.md](DEPLOY.md).


1. **Register a HubID app.** In https://hubculture.com/admin/apps/, create an app for the connector titled "Claude" (HubID shows the title on its sign-in page). Put its id and keys in `HUBID_CLIENT_ID`, `HUBID_PUBLIC_KEY` and `HUBID_PRIVATE_KEY`.
2. **Deploy behind HTTPS.** Copy `.env.example` to `.env` and fill it in. Run Redis, then `docker build -t hub-mcp . && docker run --env-file .env -p 8080:8080 hub-mcp`.
3. **Connect.** In Claude, add `https://<host>/mcp` as a custom connector. An org owner can also add it for the whole organization.

## Development

```bash
npm install
npm test        # end-to-end: full OAuth flow and tool calls against fake HubID, payments and Zeke
npm run dev     # needs a .env (or exported variables)
npx @modelcontextprotocol/inspector   # point it at http://localhost:8080/mcp
```

## Not in this version

- Pavilion admin, event moderation, health and ULTRA endpoints.
- Mandala agent identities. Agents act as the member who signed in.
- Webhooks.
- A sandbox. HubID has no test environment yet (the Mandala v2 spec proposes `sandbox.id.hubculture.com`), so every call is live.
