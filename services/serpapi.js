// services/serpapi.js
// Single place where SerpApi is called. Two rules:
//   1. The API key stays on the server - it is never sent to the browser.
//   2. Every response is cached in MongoDB for 24 hours, because the SerpApi
//      free plan only allows ~250 searches per month. The cache is checked
//      BEFORE any API call, and every function reports back whether the data
//      came from the cache (so the UI can say "using cached data").
const { getJson } = require("serpapi");
const Cache = require("../models/Cache");

const API_KEY = process.env.SERPAPI_KEY;
const TIMEOUT_MS = 20000; // give up on slow SerpApi requests after 20s

// Stable cache key: engine + params sorted alphabetically (api_key excluded).
function buildKey(engine, params) {
  const rest = { ...params };
  delete rest.api_key;
  const qs = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  return `${engine}|${qs}`;
}

// Check the cache first; only call SerpApi on a miss, then store for 24h.
// Returns { data, cached } - cached === true means no SerpApi search was used.
async function serpSearch(engine, params) {
  const key = buildKey(engine, params);

  const cached = await Cache.findOne({ key }).lean();
  if (cached) return { data: cached.data, cached: true };

  if (!API_KEY) {
    throw new Error("SERPAPI_KEY is missing. Add it to your .env file.");
  }

  let data;
  try {
    data = await getJson({ engine, api_key: API_KEY, timeout: TIMEOUT_MS, ...params });
  } catch (err) {
    // The library rejects with a string (API error body) or an Error object
    const message = typeof err === "string" ? err : err && err.message ? err.message : "Unknown error";
    throw new Error(`SerpApi request failed: ${message}`);
  }
  if (data && data.error) throw new Error(`SerpApi error: ${data.error}`);

  // Upsert so repeated searches refresh the 24h TTL window
  await Cache.updateOne(
    { key },
    { $set: { key, engine, data, createdAt: new Date() } },
    { upsert: true }
  );
  return { data, cached: false };
}

// Remember whether a group of calls ever hit the cache (for the "using cached
// data" note on the compare page).
function noteCached(flags, key, cached) {
  if (!flags || !flags[key]) return;
  flags[key] = flags[key] && cached;
}

// ---- Feature 1 + 2: find places with the google_maps engine ----
async function searchPlaces(query, flags = {}) {
  const { data, cached } = await serpSearch("google_maps", {
    q: `tourist attractions in ${query}`,
    hl: "en",
  });
  noteCached(flags, "places", cached);

  // SerpApi uses slightly different array names depending on the query shape
  const raw = data.local_results || data.places_results || data.place_results || [];
  const places = raw.map((p) => ({
    dataId: p.data_id || "", // needed by the google_maps_reviews engine
    name: p.title || "Unnamed place",
    address: p.address || "",
    rating: typeof p.rating === "number" ? p.rating : null,
    reviewCount: typeof p.reviews === "number" ? p.reviews : null,
    thumbnail: p.thumbnail || "",
    type: p.type || "",
    link: p.link || "",
    // gps_coordinates let the Leaflet safety map place a marker
    lat: p.gps_coordinates ? p.gps_coordinates.latitude : null,
    lng: p.gps_coordinates ? p.gps_coordinates.longitude : null,
  }));
  return { places, cached };
}

// ---- Feature 3a: Google reviews with the google_maps_reviews engine ----
async function getGoogleReviews(dataId, flags = {}) {
  const { data, cached } = await serpSearch("google_maps_reviews", {
    data_id: dataId,
    hl: "en",
  });
  noteCached(flags, "reviews", cached);

  const raw = data.reviews || [];
  const reviews = raw
    .map((r) => ({
      author: (r.user && r.user.name) || "Google user",
      rating: typeof r.rating === "number" ? r.rating : null,
      date: r.date || "",
      text: String(r.snippet || r.title || "").trim(),
    }))
    .filter((r) => r.text) // some reviews have no text - skip them
    .slice(0, 6); // top reviews only, keeps the page light
  return { reviews, cached };
}

// ---- Feature 3b: Reddit/Quora discussions with the google engine ----
// We only get search titles + snippets (never full threads) and link out.
async function getForumResults(placeName, flags = {}) {
  const searches = [
    { source: "Reddit", q: `site:reddit.com solo female travel ${placeName} safe` },
    { source: "Quora", q: `site:quora.com is ${placeName} safe for women` },
  ];

  // allSettled: if one query fails the other can still render
  const settled = await Promise.allSettled(
    searches.map((s) => serpSearch("google", { q: s.q, hl: "en" }))
  );

  const results = [];
  const failed = [];
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      failed.push(searches[i].source);
      return;
    }
    noteCached(flags, "forums", s.value.cached);
    const organic = (s.value.data && s.value.data.organic_results) || [];
    for (const r of organic) {
      results.push({
        source: searches[i].source,
        title: r.title || "Untitled result",
        snippet: r.snippet || "",
        link: r.link || "#",
      });
    }
  });

  // de-duplicate by link and keep the list readable
  const seen = new Set();
  const unique = results
    .filter((r) => {
      if (!r.link || seen.has(r.link)) return false;
      seen.add(r.link);
      return true;
    })
    .slice(0, 8);

  const error =
    unique.length === 0
      ? failed.length === 2
        ? "We couldn't search Reddit/Quora discussions right now. Please try again later."
        : "No Reddit or Quora discussions were found for this place."
      : failed.length
        ? "Some discussion searches failed, showing the results we found."
      : null;

  return { results: unique, error, cached: unique.length > 0 };
}

module.exports = { searchPlaces, getGoogleReviews, getForumResults };
