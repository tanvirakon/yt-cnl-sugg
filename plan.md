# YT Channel Recommender — Plan

A tool that analyzes **your own** YouTube/Google account and gives you insight into your
subscriptions. Version 1 (current, agreed scope) is a **reduced, first iteration**; the
original watch-history analytics is deferred.

---

## Goal — Iteration 1 (agreed)

1. **Capture** — pull your subscribed channels via Google OAuth.
2. **Categorize** — group them into your own buckets (English learning, politics, gaming, …).
3. **Suggest** — use **Gemini (Google's LLM, free tier — user has a key)** to recommend
   other channels you'd likely enjoy, based on your categories + a few sample channels.

> Deferred (not this iteration): watch/search history analytics ("what I watched this
> week", top channels by week, binges) — that data only exists via Google Takeout, and
> we're keeping iteration 1 simpler.

---

## Constraints / decisions

- **Local-first up to a point:** capturing + categorizing happens fully local (browser).
  The **suggestion step sends your channel/category list to Gemini** — a cloud call. User is
  aware and OK with this.
- No heavy server. Node + TypeScript; a self-contained local web app processing in the
  browser.

---

## Feasibility findings (researched, why this shape)

- **YouTube Data API v3 has NO endpoint for a user's watch/search history.** It's private
  and cannot be retrieved. Google Takeout is the only real source (deferred).
- **Subscriptions ARE available via OAuth:** `subscriptions.list` (`youtube.readonly`
  scope) returns your full subscribed-channels list.
- **Channel topics ARE available via API:** `channels.list` returns `topicCategories`
  (built-in topics) plus title/description — usable for rule-based categorization.
- **NO native "similar channels" endpoint exists in the API** — hence Gemini for
  suggestions.
- API default quota: 10,000 units/day — batch enrichment calls.

---

## Architecture — Iteration 1

- **Frontend:** local web app (browser-side JS/TS) — in project root.
- **Auth:** Google OAuth flow, scope `youtube.readonly`, using the user's Google Cloud
  project + OAuth client credentials + Data API key.
- **Data fetch (local):**
  - `subscriptions.list` → subscribed channels.
  - `channels.list` → metadata (title, description, `topicCategories`) for categorization.
- **Categorizer (local):** map channels into user buckets via topic/keyword heuristics;
  configurable categories; unclassified fallback bucket.
- **Suggestion (Gemini):** build a compact prompt from your category breakdown + a few
  sample channels → call Gemini REST API (user's free-tier key) → return recommended
  channel names/(IDs if obtainable).
- **Output:** simple report UI — categorized subscription view + a "you might like" list.

### Tech stack (proposal — user to confirm)
- Node.js (v26 installed) + TypeScript.
- Frontend: Vite + vanilla TS (lightweight) or similar.
- Gemini REST API for suggestions. No heavy backend.

---

## Open decisions

- Categorization precision: pure heuristic vs. Gemini-assisted naming for buckets. (Proposal:
  heuristic first, optionally refine with Gemini later.)
- Whether Gemini-suggested channels are validated against the API (`search.list`/
  `channels.list`) to confirm real channel IDs, or shown as name-only.
- Confirm exact categories list with user.

---

## What I need from the user

- **Google Cloud project** + **OAuth client credentials** + a **Data API key** (free) for the
  subscriptions pull. (~15 min setup.)
- **Gemini API key** (free tier) — user confirmed they have one.
- Decision on finishing setup now vs. later.

---

## Spike (throwaway) still recommended before UI polish

1. OAuth → confirm `subscriptions.list` returns real data.
2. Gemini call → confirm it returns sensible channel suggestions from a small category
   payload.
If both pass, build the real UI.

---

## History
- 2026-11-03: brainstormed feasibility (Takeout constraint established).
- 2026-11-03: narrowed iteration 1 — capture → categorize → Gemini suggestions; deferred
  watch-history analytics. User chose **Gemini LLM** for suggestions (has free-tier key).