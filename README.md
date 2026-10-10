# SafeRoute

**Find safer places to travel.** SafeRoute helps women research destinations by combining live search data from SerpApi (Google Maps places, Google reviews, Reddit/Quora discussions) with reviews written by other women on the site.

Built for the **SerpApi India Hackathon 2026** — Travel & Local Discovery track.

## Who it is for

Women (especially solo travellers) who want a quick, honest read on how safe a tourist place feels — before they go.

## Features

1. **Search** — type a city ("Jaipur", "Goa") and get tourist places via SerpApi's `google_maps` engine, rendered with htmx (no page reload).
2. **Place cards** — name, rating, address, thumbnail, and a "See safety details" button.
3. **Safety details** (htmx partial) with:
   - **Google reviews** via the `google_maps_reviews` engine (top reviews).
   - **Community discussions** via the `google` engine (`site:reddit.com` and `site:quora.com` queries) — titles, snippets and links only, never full threads.
   - **Safety score (0–100)** — a transparent keyword heuristic blended with community ratings, with a "why this score" explanation.
4. **Community reviews** — logged-out visitors can post a rating (1–5), safety rating (1–5), free text, time of day and whether they travelled alone. Shown **above** the Google results and included in the score.
5. **Caching** — every SerpApi response is stored in MongoDB with a 24-hour TTL index, keyed by engine + params. The cache is checked before any API call (free plan = 250 searches/month).
6. **Graceful errors** — friendly messages for SerpApi failures, missing API key, no results and empty reviews.

## Tech stack

Node.js + Express · EJS (server-rendered) · htmx via CDN · plain CSS (mobile-first) · MongoDB + Mongoose · official `serpapi` npm package.

## Setup

```bash
npm install
cp .env.example .env   # then edit .env
```

`.env`:

| Variable | What it is |
|---|---|
| `SERPAPI_KEY` | Your key from https://serpapi.com/manage-api-key (server-side only, never sent to the browser) |
| `MONGODB_URI` | e.g. `mongodb://127.0.0.1:27017/saferoute` (or a MongoDB Atlas URL) |
| `PORT` | defaults to `3000` |

Start MongoDB (any one of these):

```bash
docker run -d --name saferoute-mongo -p 27017:27017 mongo
# or use a local MongoDB install / Atlas and set MONGODB_URI accordingly
```

Run:

```bash
npm start          # http://localhost:3000
# or, with auto-restart on changes:
npm run dev
```

## How SerpApi is used

| Engine | Params | Role in SafeRoute |
|---|---|---|
| `google_maps` | `q: "tourist attractions in <city>"`, `hl: "en"` | Finds the places shown as cards (name, rating, address, thumbnail, `data_id`). |
| `google_maps_reviews` | `data_id: <place data_id>`, `hl: "en"` | Fetches the top Google reviews for a place's safety panel. |
| `google` | `q: "site:reddit.com solo female travel <place> safe"` and `q: "site:quora.com is <place> safe for women"`, `hl: "en"` | Finds Reddit/Quora discussions; we show title, snippet and link only. |

The API key lives in `.env` and is only ever used server-side in `services/serpapi.js`.

## How the safety score works

A deliberately simple, transparent heuristic (`services/safetyScore.js`):

1. Collect all public text: Google review snippets, Reddit/Quora titles + snippets, and SafeRoute community review text.
2. Count positive keywords (`safe`, `well lit`, `helpful`, `friendly`, `crowded`, `police`) vs negative ones (`unsafe`, `harass`, `stared`, `scam`, `followed`, `dark`, `avoid`).
3. Score = `50 + 10 × (positive − negative)`, clamped to 0–100.
4. If community reviews exist, blend: `60% keyword score + 40% community score` (community score = average safety rating × 20 × 0.6 + average overall rating × 20 × 0.4).

Every score page shows a "Why this score?" breakdown.

## Safety & abuse notes

- **XSS**: review text has HTML tags stripped on save, and all user content is rendered through EJS `<%= %>` (auto-escaped). No user content is ever rendered with `<%- %>`.
- **Rate limit**: the review form allows 5 posts per 15 minutes per IP (in-memory, `routes/index.js`).
- **Caching**: `models/Cache.js` uses a MongoDB TTL index (`expireAfterSeconds: 86400`) so entries expire automatically after 24h.

## Project structure

```
server.js               Express app, DB connect, error handlers
routes/index.js         Home, POST /search, GET /place/safety, POST /reviews (+ rate limit)
services/serpapi.js     All SerpApi calls, cache-first (google_maps, google_maps_reviews, google)
services/safetyScore.js Transparent 0-100 keyword heuristic
models/Review.js        Community reviews (Mongoose)
models/Cache.js         SerpApi response cache with 24h TTL index
views/                  EJS templates (index, error, partials/)
public/css/style.css    Mobile-first plain CSS
```

## Disclaimer

**Safety scores are estimates computed from public reviews and search results. They are not a guarantee of safety.** Always use your own judgement, check current local advice and travel smart.
