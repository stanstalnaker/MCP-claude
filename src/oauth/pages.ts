export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
  :root { color-scheme: light dark; --bg:#f7f6f3; --card:#fff; --ink:#1d1d1b; --muted:#6b6a66; --line:#e3e1db; --accent:#0f5c4d; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151514; --card:#1f1f1d; --ink:#f0efea; --muted:#a3a29c; --line:#34332f; --accent:#5cc3a8; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--ink);
         font:16px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--muted); }
  ul { margin:0 0 24px; padding-left:20px; }
  li { margin:6px 0; }
  .actions { display:flex; gap:12px; }
  button { flex:1; font:inherit; padding:10px 14px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--ink); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  small { display:block; margin-top:16px; color:var(--muted); }
`;

export function renderConsentPage(input: { pendingId: string; clientName: string; redirectHost: string; scopes: string[] }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Hub Culture</title><style>${STYLE}</style></head>
<body><main>
  <h1>Connect ${escapeHtml(input.clientName)} to Hub Culture</h1>
  <p>After you continue, you'll sign in with your HubID. ${escapeHtml(input.clientName)} will be able to:</p>
  <ul>${input.scopes.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
  <form method="post" action="/consent">
    <input type="hidden" name="pending" value="${escapeHtml(input.pendingId)}">
    <div class="actions">
      <button type="submit" name="decision" value="deny">Cancel</button>
      <button type="submit" name="decision" value="approve" class="primary">Continue to HubID</button>
    </div>
  </form>
  <small>You'll return to ${escapeHtml(input.redirectHost)}. You can disconnect at any time from your Claude connector settings.</small>
</main></body></html>`;
}

export function renderErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in problem</title><style>${STYLE}</style></head>
<body><main><h1>Sign-in didn't complete</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}
