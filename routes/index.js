// routes/index.js - all SafeRoute pages/HTMX endpoints
//   GET  /            landing page (marketing)
//   GET  /explore     search app (places + safety map)
//   POST /explore/search
//   GET  /place/safety   (htmx partial for one place)
//   POST /reviews         (htmx partial: community reviews)
//   GET  /compare        compare two destinations
//   POST /compare        (htmx partial with the side-by-side result)
const express = require("express");
const router = express.Router();

const Review = require("../models/Review");
const { searchPlaces, getGoogleReviews, getForumResults } = require("../services/serpapi");
const { computeScore } = require("../services/safetyScore");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const str = (v) => (v === null || v === undefined ? "" : String(v));

// Strip HTML tags + collapse whitespace: first line of defence against XSS.
// (EJS `<%= %>` escapes on output too - we do both.)
function clean(value, maxLen) {
  return str(value)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

// Integer within range, or null
function intIn(value, min, max) {
  const n = Number.parseInt(str(value), 10);
  if (Number.isNaN(n) || n < min || n > max) return null;
  return n;
}

// Stable key for a place: SerpApi data_id when we have it, else a name slug
function placeKeyFor(dataId, name) {
  if (dataId) return clean(dataId, 120);
  return (
    clean(name, 120)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown-place"
  );
}

// DOM ids must be valid CSS selectors (data_ids contain ":"), so sanitise
const toDomId = (key) => key.replace(/[^a-zA-Z0-9_-]/g, "-");

// Never cache HTMX responses - results should stay fresh
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Tell the shared navbar which page is active
router.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.navActive = req.path.startsWith("/explore")
    ? "explore"
    : req.path.startsWith("/compare")
      ? "compare"
      : "";
  next();
});

// ---------------------------------------------------------------------------
// Simple in-memory rate limit for the review form (per IP).
// Keeps anonymous spam out without a login.
// ---------------------------------------------------------------------------
const RATE = { windowMs: 15 * 60 * 1000, max: 5 };
const hits = new Map();

function reviewRateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < RATE.windowMs);
  if (list.length >= RATE.max) {
    hits.set(req.ip, list);
    return renderCommunity(res, {
      placeKey: clean(req.body.placeKey, 120),
      placeName: clean(req.body.placeName, 200),
      notice:
        "You have posted several reviews recently - please wait about 15 minutes and try again. Thank you!",
      status: 429,
    });
  }
  list.push(now);
  hits.set(req.ip, list);
  next();
}

// Load a place's community reviews (used by the safety panel and after posting)
async function loadCommunity(placeKey) {
  try {
    return await Review.find({ placeKey }).sort({ createdAt: -1 }).limit(20).lean();
  } catch (err) {
    console.error("Could not load community reviews:", err.message);
    return [];
  }
}

// Render the SafeRoute community reviews partial (also used for form errors,
// which we answer with HTTP 200 so htmx always swaps the message in).
async function renderCommunity(res, { placeKey, placeName, notice = null, status = 200 }) {
  const reviews = placeKey ? await loadCommunity(placeKey) : [];
  res.status(status).render("partials/communityReviews", {
    reviews,
    notice,
    placeKey,
    placeName,
  });
}

// ---------------------------------------------------------------------------
// Landing page (marketing) and the search app
// ---------------------------------------------------------------------------
router.get("/", (req, res) => {
  res.render("landing", { title: "SafeRoute — Travel far. Feel safe everywhere." });
});

router.get("/explore", (req, res) => {
  res.render("explore", { query: "" });
});

// ---------------------------------------------------------------------------
// HTMX: search for places (google_maps engine)
// ---------------------------------------------------------------------------
router.post("/explore/search", async (req, res) => {
  const query = clean(req.body.q, 100);

  if (!query) {
    return res.render("partials/places", {
      places: [],
      query: "",
      error: "Please enter a place to search, for example Jaipur or Goa.",
    });
  }

  try {
    const { places } = await searchPlaces(query);
    res.render("partials/places", {
      places,
      query,
      error: places.length
        ? null
        : `We could not find any tourist places for "${query}". Try another spelling or a bigger city.`,
    });
  } catch (err) {
    console.error("Search failed:", err.message);
    res.render("partials/places", {
      places: [],
      query,
      error:
        "Live search is unavailable right now (SerpApi issue or missing API key). Please try again in a moment.",
    });
  }
});

// ---------------------------------------------------------------------------
// HTMX: safety details for one place
// (Google reviews + Reddit/Quora discussions + score + community reviews)
// ---------------------------------------------------------------------------
router.get("/place/safety", async (req, res) => {
  const name = clean(req.body.name || req.query.name, 200);
  const address = clean(req.body.address || req.query.address, 300);
  const dataId = clean(req.body.dataId || req.query.dataId, 120);

  if (!name) {
    return res.render("partials/safety", {
      error: "We could not load this place. Please search again.",
    });
  }

  const placeKey = placeKeyFor(dataId, name);
  const domId = toDomId(placeKey);

  // Each source is fetched independently so one failure never breaks the page
  let communityReviews = [];
  let googleReviews = [];
  let googleReviewsError = null;
  let forums = { results: [], error: null };

  communityReviews = await loadCommunity(placeKey);

  if (dataId) {
    try {
      const g = await getGoogleReviews(dataId);
      googleReviews = g.reviews;
      if (googleReviews.length === 0) {
        googleReviewsError = "No written Google reviews were found for this place yet.";
      }
    } catch (err) {
      console.error("Google reviews failed:", err.message);
      googleReviewsError = "Google reviews could not be loaded right now.";
    }
  } else {
    googleReviewsError = "Google reviews are not available for this place.";
  }

  try {
    forums = await getForumResults(name);
  } catch (err) {
    console.error("Forum search failed:", err.message);
    forums = { results: [], error: "Reddit/Quora discussions could not be loaded right now." };
  }

  const score = computeScore({
    googleReviews,
    forumResults: forums.results,
    communityReviews,
  });

  res.render("partials/safety", {
    error: null,
    name,
    address,
    placeKey,
    domId,
    googleReviews,
    googleReviewsError,
    forums,
    communityReviews,
    score,
  });
});

// ---------------------------------------------------------------------------
// HTMX: submit a community review (no account required)
// ---------------------------------------------------------------------------
router.post("/reviews", reviewRateLimit, async (req, res) => {
  const placeKey = clean(req.body.placeKey, 120);
  const placeName = clean(req.body.placeName, 200);
  const text = clean(req.body.text, 1000);
  const rating = intIn(req.body.rating, 1, 5);
  const safetyRating = intIn(req.body.safetyRating, 1, 5);
  const timeOfDay = ["morning", "afternoon", "evening", "night"].includes(req.body.timeOfDay)
    ? req.body.timeOfDay
    : "afternoon";
  const travelledAlone = str(req.body.travelledAlone).toLowerCase() === "yes";

  const errors = [];
  if (!placeKey || !placeName) errors.push("Place information was missing - reopen the safety details and try again.");
  if (!rating) errors.push("Please choose an overall rating (1-5).");
  if (!safetyRating) errors.push("Please choose a safety rating (1-5).");
  if (!text) errors.push("Please write a short review (tags are removed).");
  else if (text.length < 10) errors.push("Your review is too short - a sentence or two helps others.");

  if (errors.length) {
    return renderCommunity(res, { placeKey, placeName, notice: errors.join(" ") });
  }

  try {
    await Review.create({
      placeKey,
      placeName,
      rating,
      safetyRating,
      text,
      timeOfDay,
      travelledAlone,
    });
  } catch (err) {
    console.error("Saving review failed:", err.message);
    return renderCommunity(res, {
      placeKey,
      placeName,
      notice: "Your review could not be saved right now. Please try again.",
    });
  }

  return renderCommunity(res, {
    placeKey,
    placeName,
    notice: "Thanks! Your review is now part of the SafeRoute community ratings.",
  });
});

// ---------------------------------------------------------------------------
// Compare two destinations
// Hard rule: everything goes through the 24h MongoDB cache (services/serpapi.js
// checks it before every SerpApi call), so repeated comparisons never burn
// the 250 free monthly searches.
// ---------------------------------------------------------------------------
router.get("/compare", (req, res) => {
  res.render("compare", { cityA: "", cityB: "" });
});

// Score ONE city: places via google_maps, then Google reviews for the top 3
// places only (google_maps_reviews). City score = average of those 3 scores.
async function scoreCity(query, flags) {
  let places;
  try {
    ({ places } = await searchPlaces(query, flags));
  } catch (err) {
    console.error(`Compare: search failed for "${query}":`, err.message);
    return { query, error: "Live search is unavailable right now. Please try again in a moment.", places: [] };
  }
  if (!places.length) {
    return { query, error: `We could not find any tourist places for "${query}". Try another spelling or a bigger city.`, places: [] };
  }

  const scored = [];
  for (const p of places.slice(0, 3)) {
    const placeKey = placeKeyFor(p.dataId, p.name);
    let googleReviews = [];
    if (p.dataId) {
      try {
        ({ reviews: googleReviews } = await getGoogleReviews(p.dataId, flags));
      } catch (err) {
        console.error(`Compare: reviews failed for "${p.name}":`, err.message);
      }
    }
    const communityReviews = await loadCommunity(placeKey);
    const score = computeScore({ googleReviews, forumResults: [], communityReviews });
    scored.push({ ...p, score });
  }

  const withScores = scored.filter((s) => s.score);
  const avg = (key) =>
    withScores.length
      ? Math.round(withScores.reduce((a, s) => a + (s.score[key] ?? s.score.overall), 0) / withScores.length)
      : null;

  // Aggregate sub-signals across the top 3 places
  const signals = { harassment: 0, crowdLighting: 0, helpfulLocals: 0, soloWomen: 0 };
  withScores.forEach((s) => {
    signals.harassment += s.score.signals.harassment;
    signals.crowdLighting += s.score.signals.crowdLighting;
    signals.helpfulLocals += s.score.signals.helpfulLocals;
    signals.soloWomen += s.score.signals.soloWomen;
  });

  return {
    query,
    error: null,
    places: scored,
    overall: avg("overall"),
    day: avg("day"),
    night: avg("night"),
    signals,
  };
}

router.post("/compare", async (req, res) => {
  const cityA = clean(req.body.cityA, 100);
  const cityB = clean(req.body.cityB, 100);

  if (!cityA || !cityB) {
    return res.render("partials/compareResult", {
      cityA: { query: cityA, error: "Please enter a city.", places: [] },
      cityB: { query: cityB, error: "Please enter a city.", places: [] },
      usingCached: false,
    });
  }

  // Both cities in parallel; each keeps its own cache flags
  const flagsA = { places: true, reviews: true };
  const flagsB = { places: true, reviews: true };
  const [resultA, resultB] = await Promise.all([scoreCity(cityA, flagsA), scoreCity(cityB, flagsB)]);

  // "using cached data" only when EVERY lookup for BOTH cities was cached
  const usingCached =
    !resultA.error && !resultB.error && flagsA.places && flagsA.reviews && flagsB.places && flagsB.reviews;

  res.render("partials/compareResult", { cityA: resultA, cityB: resultB, usingCached });
});

module.exports = router;
