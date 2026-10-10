// services/safetyScore.js
// A deliberately SIMPLE, TRANSPARENT heuristic - not a real safety assessment.
//
// Returned shape:
//   {
//     overall,          // 0-100 weighted keyword score
//     day, night,       // 0-100 sub-scores (fall back to `overall` if no data)
//     band, bandLabel,  // high (>=70) / mid (40-69) / low (<40)
//     signals,          // { harassment, crowdLighting, helpfulLocals, soloWomen, nightMentions, dayMentions }
//     explanation       // [short human-readable "why this score" lines]
//   }
//
// Weighting rules (all visible in the UI):
//   - Recency: a review from the last ~30 days counts full, older ones fade
//     (weight = 1 / (1 + daysOld / 30)). Undated snippets get 0.6.
//   - Solo-women boost: reviews mentioning solo/alone/female/women/girl count 1.5x.
//   - Day vs night: reviews mentioning night/evening/late/after dark feed the
//     NIGHT sub-score; morning/afternoon/day feed the DAY sub-score; reviews
//     mentioning neither feed both.
//   - Sub-signals tracked: harassment, crowd/lighting, helpful-locals mentions.

const POSITIVE = ["safe", "well lit", "helpful", "friendly", "crowded", "police"];
const NEGATIVE = ["unsafe", "harass", "stared", "scam", "followed", "dark", "avoid"];

const NIGHT_TERMS = ["night", "evening", "after dark", "late"];
const DAY_TERMS = ["morning", "afternoon", "daytime", "day"];
const SOLO_TERMS = ["solo", "alone", "female", "women", "woman", "girl"];

// Sub-signal groups (raw counts across ALL texts, weighted or not)
const HARASS_TERMS = ["harass", "stared", "followed", "eve teasing", "catcall", "creepy"];
const CROWD_TERMS = ["crowded", "well lit", "police", "cctv", "dark", "lit", "lighting"];
const HELPFUL_TERMS = ["helpful", "friendly", "locals", "kind", "welcoming"];

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

// Lowercase + treat dashes as spaces so "well-lit" matches "well lit"
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[-\u2013\u2014]/g, " ")
    .replace(/\s+/g, " ");
}

// Word-boundary count: "safe" does NOT match inside "unsafe", but simple
// suffixes do ("safe" ~ "safety", "harass" ~ "harassment").
function countMatches(text, words) {
  const counts = {};
  const t = normalize(text);
  for (const w of words) {
    const hits = t.match(new RegExp(`\\b${w}\\w*\\b`, "g"));
    if (hits) counts[w] = hits.length;
  }
  return counts;
}

function sum(obj) {
  return Object.values(obj).reduce((a, b) => a + b, 0);
}

// Parse Google review dates like "2 days ago", "a month ago" -> days old.
// Returns null when unparseable.
function daysAgo(dateText) {
  const m = String(dateText || "")
    .toLowerCase()
    .match(/(\d+|a|an)\s+(hour|day|week|month|year)s?\s+ago/);
  if (!m) return null;
  const n = m[1] === "a" || m[1] === "an" ? 1 : parseInt(m[1], 10);
  const unit = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2]];
  return n * unit;
}

// Recency weight: 1 today, ~0.5 after a month, ~0.25 after three months.
function recencyWeight(daysOld) {
  if (daysOld === null || daysOld === undefined) return 0.6; // undated snippet
  return 1 / (1 + daysOld / 30);
}

function mentionsAny(text, words) {
  const t = normalize(text);
  return words.some((w) => new RegExp(`\\b${w}\\w*\\b`).test(t));
}

/**
 * @param {object} input
 * @param {Array<{text:string, date?:string}>} input.googleReviews
 * @param {Array<{title:string, snippet:string}>} input.forumResults
 * @param {Array<{text:string, createdAt:string|Date}>} input.communityReviews
 */
function computeScore({ googleReviews = [], forumResults = [], communityReviews = [] }) {
  // 1. Normalise every source into one list of text items.
  //    Forum snippets have no date -> recencyWeight() gives them 0.6.
  const items = [];
  googleReviews.forEach((r) =>
    items.push({ text: r.text, daysOld: daysAgo(r.date), source: "google" })
  );
  forumResults.forEach((r) =>
    items.push({ text: `${r.title} ${r.snippet}`, daysOld: null, source: "forum" })
  );
  communityReviews.forEach((r) =>
    items.push({
      text: r.text,
      daysOld: (Date.now() - new Date(r.createdAt).getTime()) / 86400000,
      source: "community",
    })
  );

  // 2. Per-item weight: recency x solo-women boost
  let soloWomenCount = 0;
  let nightMentions = 0;
  let dayMentions = 0;
  for (const item of items) {
    item.solo = mentionsAny(item.text, SOLO_TERMS);
    if (item.solo) soloWomenCount++;
    item.isNight = mentionsAny(item.text, NIGHT_TERMS);
    item.isDay = mentionsAny(item.text, DAY_TERMS);
    if (item.isNight) nightMentions++;
    if (item.isDay) dayMentions++;
    // bucket(s) this review feeds: night, day, or both when unspecified
    item.buckets = item.isNight || item.isDay ? [...new Set([item.isNight ? "night" : null, item.isDay ? "day" : null])] : ["day", "night"];
    item.weight = recencyWeight(item.daysOld) * (item.solo ? 1.5 : 1);
  }

  // 3. Weighted keyword counts per bucket (overall = both buckets combined)
  const tally = (bucket) => {
    const pos = {};
    const neg = {};
    for (const item of items) {
      if (bucket !== "all" && !item.buckets.includes(bucket)) continue;
      const w = item.weight;
      for (const [k, v] of Object.entries(countMatches(item.text, POSITIVE)))
        pos[k] = (pos[k] || 0) + v * w;
      for (const [k, v] of Object.entries(countMatches(item.text, NEGATIVE)))
        neg[k] = (neg[k] || 0) + v * w;
    }
    return { pos, neg, posTotal: sum(pos), negTotal: sum(neg) };
  };

  const keywordScore = ({ posTotal, negTotal }) => clamp(50 + 10 * (posTotal - negTotal));

  const all = tally("all");
  const dayT = tally("day");
  const nightT = tally("night");

  const overall = keywordScore(all);
  const day = dayT.posTotal + dayT.negTotal > 0 ? keywordScore(dayT) : overall;
  const night = nightT.posTotal + nightT.negTotal > 0 ? keywordScore(nightT) : overall;

  // 4. Raw sub-signal counts across ALL texts (unweighted, easy to explain)
  const countAll = (words) =>
    items.reduce((acc, item) => acc + sum(countMatches(item.text, words)), 0);
  const signals = {
    harassment: countAll(HARASS_TERMS),
    crowdLighting: countAll(CROWD_TERMS),
    helpfulLocals: countAll(HELPFUL_TERMS),
    soloWomen: soloWomenCount,
    nightMentions,
    dayMentions,
  };

  // 5. Short, human-readable "why this score" lines
  const explanation = [];
  if (items.length === 0) {
    explanation.push("No public reviews or discussions were found, so the score stays at the neutral midpoint (50).");
  } else {
    explanation.push(
      `Scanned ${items.length} public texts (Google reviews, Reddit/Quora snippets, community reviews).`
    );
    explanation.push(
      `Weighted ${all.posTotal.toFixed(1)} positive vs ${all.negTotal.toFixed(1)} negative safety signals.`
    );
    explanation.push("Base 50, +10 per positive signal, -10 per negative signal, clamped to 0-100.");
    if (nightMentions) explanation.push(`${nightMentions} review(s) mention night/evening/late - they shape the night score.`);
    if (soloWomenCount)
      explanation.push(`${soloWomenCount} review(s) mention solo/alone/female - those count 1.5x.`);
    explanation.push(
      `Signals found: ${signals.harassment} harassment, ${signals.crowdLighting} crowd/lighting, ${signals.helpfulLocals} helpful-locals mentions.`
    );
  }
  explanation.push("Estimate based on public reviews - not a guarantee of safety.");

  const band = overall >= 70 ? "high" : overall >= 40 ? "mid" : "low";
  const bandLabel =
    band === "high" ? "Looks positive" : band === "mid" ? "Mixed signals" : "Needs caution";

  return {
    overall,
    day,
    night,
    band,
    bandLabel,
    signals,
    explanation,
  };
}

module.exports = { computeScore, POSITIVE, NEGATIVE };
