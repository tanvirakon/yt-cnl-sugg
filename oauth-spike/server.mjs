// OAuth spike — Google sign-in -> subscriptions.list (throwaway)
// Run: node --env-file=.env oauth-spike/server.mjs
// Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env
import http from "node:http";
import { URL } from "node:url";

const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) {
  console.error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>YT OAuth spike</title>
<style>body{font-family:system-ui;max-width:740px;margin:3rem auto;padding:0 1rem}
a,button{display:inline-block;padding:.6rem 1rem;background:#0b57d0;color:#fff;
text-decoration:none;border:none;border-radius:6px;cursor:pointer}
pre{background:#f4f4f4;padding:1rem;border-radius:6px;max-height:70vh;overflow:auto}</style></head><body>${body}</body></html>`;
}

async function getSubscriptions(accessToken) {
  const out = [];
  let pageToken = "";
  do {
    const url =
      "https://www.googleapis.com/youtube/v3/subscriptions?mine=true&part=snippet,contentDetails&maxResults=50" +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`subscriptions.list failed (${r.status}): ${t}`);
    }
    const j = await r.json();
    for (const it of j.items || []) {
      out.push({
        channelId: it.snippet.resourceId.channelId,
        title: it.snippet.title,
        description: (it.snippet.description || "").slice(0, 160),
      });
    }
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page(`<h1>YT OAuth spike</h1><a href="${authUrl}">Sign in with Google</a>`));
    return;
  }

  if (url.pathname === "/oauth2callback") {
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    if (err) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`<h2>Auth error</h2><pre>${err}</pre>`));
      return;
    }
    try {
      const tok = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: REDIRECT,
          grant_type: "authorization_code",
        }),
      });
      if (!tok.ok) {
        const t = await tok.text();
        throw new Error(`token exchange failed (${tok.status}): ${t}`);
      }
      const { access_token: accessToken } = await tok.json();

      const subs = await getSubscriptions(accessToken);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        page(
          `<h1>Success — ${subs.length} subscriptions</h1>
           <a href="/">start over</a>
           <h2>First 20 channels</h2>
           <ul>${subs
             .slice(0, 20)
             .map((s) => `<li><strong>${escapeHtml(s.title)}</strong> — <code>${s.channelId}</code></li>`)
             .join("")}</ul>
           <h2>Full JSON</h2><pre>${escapeHtml(JSON.stringify(subs, null, 2))}</pre>`
        )
      );
    } catch (e) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`<h2>Error</h2><pre>${escapeHtml(e.message)}</pre><a href="/">try again</a>`));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => console.log(`Spike running: http://localhost:${PORT}`));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}