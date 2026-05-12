// Per-game chatter from Bluesky. Each game gets its own searchPosts query
// against the public AppView — that way the score reflects actual posts about
// THAT game, not a fixed pool divvied across the league. Popular games
// legitimately outscore quiet ones.
//
// Uses sort=latest so timestamps are meaningful for rate calculation.
//
// Three independent 0-100 scores per game:
//   chatter      — posts-per-minute rate + acceleration across all matched posts
//   goodChatter  — same metric, computed over excitement-bucketed posts
//   badChatter   — same metric, computed over boring-bucketed posts
// All three can be high simultaneously (passionate, mixed-reactions game).

import {
  EXCITEMENT_WORDS,
  BORING_WORDS,
  BLUESKY_LIMIT_PER_GAME,
  BLUESKY_SINCE_OFFSET_MS,
} from '../config.js';
import { calcChatterPpm } from './algorithm.js';
import { getAccessJwt, refreshAccessJwt, authConfigured } from './bsky-auth.js';

// Note: app.bsky.feed.searchPosts is blocked behind a CDN 403 on
// public.api.bsky.app (anti-scraping), but the same AppView serves it without
// auth on api.bsky.app. Other endpoints (getProfile etc.) work on either.
const APPVIEW = 'https://api.bsky.app/xrpc';
const HEADERS = { 'User-Agent': 'Squeaker/1.0 (squeaker.app)' };

// ── Public ────────────────────────────────────────────────────────────────────

// Fetch + score in one call. Returns null if no posts match.
// Pass { includeSample: true } to get a labeled post snapshot in result.sample
// (used by the live-game sampler in warmup.js — not stored in the peak).
// Pass peakPpm / floorPpm (and good/bad variants) derived from the game's own
// ppm history so the score is self-normalizing: 100 = at peak, 0 = at floor.
// Supplied by the caller (warmup.js) from the cached chatter object.
export async function chatterForGame(game, {
  includeSample = false,
  peakPpm = 0,  floorPpm = 0,
  peakGoodPpm = 0, floorGoodPpm = 0,
  peakBadPpm  = 0, floorBadPpm  = 0,
} = {}) {
  const posts = await searchPosts(game);
  if (posts.length === 0) return null;
  const matches = matchGame(game, posts);
  if (matches.length === 0) return null;
  return scoreChatter(matches, {
    includeSample,
    peakPpm, floorPpm,
    peakGoodPpm, floorGoodPpm,
    peakBadPpm, floorBadPpm,
  });
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function searchPosts(game) {
  const homeName = lastWord(game.home.name);
  const awayName = lastWord(game.away.name);
  // Both names space-separated. Bluesky's search defaults to AND-ish behavior
  // for multiple terms; we re-filter client-side in matchGame anyway so this
  // is belt-and-suspenders.
  const q = `${homeName} ${awayName}`;

  const gameTs = game.date ? new Date(game.date).getTime() : Date.now();
  const sinceIso = new Date(gameTs - BLUESKY_SINCE_OFFSET_MS).toISOString();

  const url =
    `${APPVIEW}/app.bsky.feed.searchPosts` +
    `?q=${encodeURIComponent(q)}` +
    `&limit=${BLUESKY_LIMIT_PER_GAME}` +
    `&sort=latest` +
    `&lang=en` +
    `&since=${encodeURIComponent(sinceIso)}`;

  let res = await sendSearchRequest(url, await getAccessJwt(), q);
  if (!res) return [];

  // 401 on an authenticated request means our token expired or was revoked.
  // Refresh once and retry; if refresh also fails, getAccessJwt returns null
  // and we fall back to anonymous which is still better than nothing.
  if (res.status === 401 && authConfigured()) {
    await drain(res);
    const newJwt = await refreshAccessJwt();
    if (newJwt) {
      res = await sendSearchRequest(url, newJwt, q);
      if (!res) return [];
    }
  }

  if (res.status === 429) {
    console.warn(`[bluesky] 429 rate-limited on "${q}"`);
    await drain(res);
    return [];
  }
  if (!res.ok) {
    let snippet = '';
    try {
      const body = await res.text();
      snippet = body.slice(0, 200).replace(/\s+/g, ' ');
    } catch { /* ignore */ }
    console.warn(`[bluesky] HTTP ${res.status} on "${q}" body=${snippet}`);
    return [];
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.error(`[bluesky] JSON parse failed (${q}): ${e.message}`);
    return [];
  }

  const raw = data?.posts || [];
  const out = [];
  for (const p of raw) {
    const n = normalizePost(p);
    if (n) out.push(n);
  }
  data = null;
  return out;
}

// Single fetch attempt with optional bearer auth. Returns the Response on
// any HTTP outcome, or null on network error (caller treats null as "skip
// this game this cycle"). Auth header is omitted when jwt is null so the
// unauth fallback path stays exactly like the original anonymous request.
async function sendSearchRequest(url, jwt, q) {
  const headers = { ...HEADERS };
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  try {
    return await fetch(url, { headers });
  } catch (e) {
    console.error(`[bluesky] fetch error (${q}): ${e.message}`);
    return null;
  }
}

async function drain(res) {
  try {
    await res.text();
  } catch {
    /* ignore */
  }
}

function normalizePost(p) {
  const text = p?.record?.text;
  if (!text) return null;
  return {
    text,
    textLower: text.toLowerCase(),
    likes:   p.likeCount   | 0,
    reposts: (p.repostCount | 0) + (p.quoteCount | 0),
    replies: p.replyCount  | 0,
    indexedAt: p.indexedAt || null,
  };
}

// ── Matching ──────────────────────────────────────────────────────────────────

function matchGame(game, posts) {
  // Mirror reddit.js matching: full name OR last-word OR abbreviation,
  // require both teams in the post text.
  const homeFull = (game.home.fullName || game.home.name).toLowerCase();
  const awayFull = (game.away.fullName || game.away.name).toLowerCase();
  const homeAbbr = (game.home.abbr || '').toLowerCase();
  const awayAbbr = (game.away.abbr || '').toLowerCase();
  const homeLast = lastWord(game.home.name).toLowerCase();
  const awayLast = lastWord(game.away.name).toLowerCase();

  const out = [];
  for (const p of posts) {
    const t = p.textLower;
    const home =
      (homeFull && t.includes(homeFull)) ||
      (homeLast && t.includes(homeLast)) ||
      (homeAbbr && t.includes(homeAbbr));
    const away =
      (awayFull && t.includes(awayFull)) ||
      (awayLast && t.includes(awayLast)) ||
      (awayAbbr && t.includes(awayAbbr));
    if (home && away) out.push(p);
  }
  return out;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreChatter(matches, {
  includeSample = false,
  peakPpm = 0,  floorPpm = 0,
  peakGoodPpm = 0, floorGoodPpm = 0,
  peakBadPpm  = 0, floorBadPpm  = 0,
} = {}) {
  // Bucket each post by sentiment. A post can land in both if it contains
  // terms from both lists — "blowout but what a finish" contributes to both.
  const goodPosts = [];
  const badPosts  = [];
  for (const p of matches) {
    const hasGood = anyHit(p.textLower, EXCITEMENT_WORDS);
    const hasBad  = anyHit(p.textLower, BORING_WORDS);
    if (hasGood) goodPosts.push(p);
    if (hasBad)  badPosts.push(p);
  }

  const ppm     = computePpm(matches);
  const goodPpm = computePpm(goodPosts);
  const badPpm  = computePpm(badPosts);

  const chatter     = calcChatterPpm(ppm,     peakPpm,     floorPpm);
  const goodChatter = calcChatterPpm(goodPpm, peakGoodPpm, floorGoodPpm);
  const badChatter  = calcChatterPpm(badPpm,  peakBadPpm,  floorBadPpm);

  // Aggregate engagement counts — kept for debug/history but not used in score.
  let likes = 0, reposts = 0, replies = 0;
  for (const p of matches) {
    likes   += p.likes;
    reposts += p.reposts;
    replies += p.replies;
  }

  const result = {
    chatter,
    goodChatter,
    badChatter,
    ppm,
    goodPpm,
    badPpm,
    matchedPosts: matches.length,
    goodPosts:    goodPosts.length,
    badPosts:     badPosts.length,
    likes,
    reposts,
    replies,
  };

  if (includeSample) {
    const goodSet = new Set(goodPosts);
    const badSet  = new Set(badPosts);
    result.sample = [...matches]
      .sort((a, b) => (b.likes + b.reposts + b.replies) - (a.likes + a.reposts + a.replies))
      .map(p => ({
        text:      p.text,
        likes:     p.likes,
        reposts:   p.reposts,
        replies:   p.replies,
        indexedAt: p.indexedAt,
        bad:       badSet.has(p)  ? getHits(p.textLower, BORING_WORDS)     : [],
        good:      goodSet.has(p) ? getHits(p.textLower, EXCITEMENT_WORDS) : [],
      }));
  }

  return result;
}

// Posts-per-minute rate derived from the indexedAt timestamps of the given
// posts. With sort=latest the newest posts come first, so the oldest timestamp
// tells us how far back this batch spans.
// Falls back to the full since-window when no timestamps are present.
function computePpm(posts) {
  if (posts.length === 0) return 0;
  const now = Date.now();
  const stamped = posts.filter(p => p.indexedAt);
  if (stamped.length === 0) {
    // No timestamps — use the full search window as the denominator.
    return posts.length / (BLUESKY_SINCE_OFFSET_MS / 60000);
  }
  const oldest = Math.min(...stamped.map(p => new Date(p.indexedAt).getTime()));
  // Floor at 1 minute so a burst of simultaneous posts doesn't produce Infinity.
  const spanMin = Math.max(1, (now - oldest) / 60000);
  return posts.length / spanMin;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Use word-boundary matching for single words so "bro" doesn't match "broke",
// "series" doesn't match "serious", etc. Phrases (spaces) and emoji use plain
// substring matching since they're specific enough already.
function wordMatch(text, w) {
  if (/\p{Emoji}/u.test(w) || w.includes(' ')) return text.includes(w);
  return new RegExp(`\\b${escapeRegex(w)}\\b`).test(text);
}

function anyHit(text, words) {
  for (const w of words) if (wordMatch(text, w)) return true;
  return false;
}

function getHits(text, words) {
  return words.filter(w => wordMatch(text, w));
}

function lastWord(s) {
  if (!s) return '';
  const parts = s.trim().split(/\s+/);
  return parts[parts.length - 1];
}
