// YT Channel Recommender — backend
// Handles OAuth callback, saves subscriptions to data/subs.json, proxies Gemini.
import express from "express";
import { URL } from "node:url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const SUBS_FILE = join(DATA_DIR, "subs.json");
mkdirSync(DATA_DIR, { recursive: true });

const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) {
  console.error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env");
  process.exit(1);
}

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
// Ordered fallback list: env override first, then newer flash, then an older stable one.
const GEMINI_MODELS = (process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.0-flash"]
).filter(Boolean);

async function geminiGenerate(prompt) {
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7 },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    lastErr = { status: r.status, model, detail: j };
    // stop if it's a config error (not a transient/saturation issue)
    if (r.status === 400 || r.status === 404 || r.status === 403) break;
  }
  throw new Error(`Gemini failed on all models: ${JSON.stringify(lastErr)}`);
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

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

async function fetchAllSubscriptions(accessToken) {
  const out = [];
  let pageToken = "";
  do {
    const url =
      "https://www.googleapis.com/youtube/v3/subscriptions?mine=true&part=snippet&maxResults=50" +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`subscriptions.list failed (${r.status}): ${await r.text()}`);
    const j = await r.json();
    for (const it of j.items || []) {
      out.push({
        channelId: it.snippet.resourceId.channelId,
        title: it.snippet.title,
        description: (it.snippet.description || "").slice(0, 300),
      });
    }
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

app.get("/auth", (_req, res) => res.redirect(authUrl));

app.get("/oauth2callback", async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    res.status(400).send(`<h2>Auth error: ${error}</h2><a href="/">back</a>`);
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
    if (!tok.ok) throw new Error(`token exchange failed (${tok.status}): ${await tok.text()}`);
    const { access_token: accessToken } = await tok.json();

    const subs = await fetchAllSubscriptions(accessToken);
    writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), "utf-8");
    res.redirect("/?loaded=1&count=" + subs.length);
  } catch (e) {
    res.status(500).send(`<h2>Error</h2><pre>${e.message}</pre><a href="/">back</a>`);
  }
});

app.get("/api/subs", (_req, res) => {
  if (!existsSync(SUBS_FILE)) return res.json({ loaded: false, subs: [] });
  res.json({ loaded: true, subs: JSON.parse(readFileSync(SUBS_FILE, "utf-8")) });
});

// POST /api/suggest  { summary }  -> Gemini suggestions (non-streaming)
app.post("/api/suggest", async (req, res) => {
  if (!GEMINI_KEY) return res.status(400).json({ error: "GEMINI_API_KEY not set in .env" });
  const { summary } = req.body || {};
  if (!summary) return res.status(400).json({ error: "missing summary" });
  try {
    const j = await geminiGenerate(summary);
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text).join("\n");
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/suggest/stream  { summary }  -> Gemini suggestions (streamed as SSE)
app.post("/api/suggest/stream", async (req, res) => {
  if (!GEMINI_KEY) return res.status(400).json({ error: "GEMINI_API_KEY not set in .env" });
  const { summary } = req.body || {};
  if (!summary) return res.status(400).json({ error: "missing summary" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let lastErr = null;
  try {
    for (const model of GEMINI_MODELS) {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent` +
        `?alt=sse&key=${GEMINI_KEY}`;
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: summary }] }],
          generationConfig: { temperature: 0.7 },
        }),
      });
      if (!upstream.ok) {
        const j = await upstream.json().catch(() => ({}));
        lastErr = { status: upstream.status, model, detail: j };
        if (upstream.status === 400 || upstream.status === 403 || upstream.status === 404) break;
        continue; // retry next fallback model
      }
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sawCandidate = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Robust: process every complete newline-terminated line; keep last partial.
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          let parsed;
          try {
            parsed = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          const textPart = parsed.candidates?.[0]?.content?.parts
            ?.map((p) => p.text || "")
            .join("");
          if (textPart) {
            sawCandidate = true;
            send({ text: textPart });
          }
        }
      }
      // flush any final remainder without a trailing newline
      if (buf.trim().startsWith("data:")) {
        try {
          const parsed = JSON.parse(buf.slice(5).trim());
          const textPart =
            parsed.candidates?.[0]?.content?.parts
              ?.map((p) => p.text || "")
              .join("");
          if (textPart) send({ text: textPart });
        } catch {
          /* ignore partial/malformed tail */
        }
      }
      send({ done: true });
      res.end();
      return;
    }
    throw new Error(
      `Gemini stream failed on all models: ${JSON.stringify(lastErr)}`
    );
  } catch (e) {
    try {
      send({ error: e.message });
      res.end();
    } catch {
      /* client may have disconnected */
    }
  }
});

app.listen(PORT, () => console.log(`Running: http://localhost:${PORT}`));