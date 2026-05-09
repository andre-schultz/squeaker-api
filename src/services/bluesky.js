// Per-game chatter from Bluesky. Each game gets its own searchPosts query
// against the public AppView (no auth) — that way the score reflects actual
// posts about THAT game, not a fixed pool divvied across the league. Popular
// games legitimately outscore quiet ones.
//
// Three independent 0-100 scores per game:
//   chatter      — overall volume across all matched posts
//   goodChatter  — same metric, computed over excitement-bucketed posts
//   badChatter   — same metric, computed over boring-bucketed posts
// All three can be high simultaneously (passionate, mixed-reactions game).

import {
  EXCITEMENT_WORDS,
  BORING_WORDS,
  BLUESKY_LIMIT_PER_GAME,
  BLUESKY_SINCE_OFFSET_MS,
  CHATTER_BASELINES,
} from '../config.js';
import { calcChatter } from './algorithm.js';
import { getAccessJwt, refreshAccessJwt, authConfigured } from './bsky-auth.js';

// Note: app.bsky.feed.searchPosts is blocked behind a CDN 403 on
// public.api.bsky.app (anti-scraping), but the same AppView serves it without
// auth on api.bsky.app. Other endpoints (getProfile etc.) work on either.
const APPVIEW = 'https://api.bsky.app/xrpc';
const HEADERS = { 'User-Agent': 'Squeaker/1.0 (squeaker.app)' };

// ── Public ────────────────────────────────────────────────────────────────────

// Fetch + score in one call. Returns null if no posts match.
export async function chatterForGame(game) {
  const posts = await searchPosts(game);
  if (posts.length === 0) return null;
  const matches = matchGame(game, posts);
  if (matches.length === 0) return null;
  return scoreChatter(matches);
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
    `&sort=top` +
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

function scoreChatter(matches) {
  // Bucket each post by sentiment hits in its body. A post can be in BOTH
  // good and bad if it contains terms from both lists — e.g. "blowout but
  // what a finish". That's intentional: it represents mixed reactions and
  // contributes to both poles.
  const goodPosts = [];
  const badPosts  = [];
  for (const p of matches) {
    const hasGood = anyHit(p.textLower, EXCITEMENT_WORDS);
    const hasBad  = anyHit(p.textLower, BORING_WORDS);
    if (hasGood) goodPosts.push(p);
    if (hasBad)  badPosts.push(p);
  }

  const all  = aggregate(matches);
  const good = aggregate(goodPosts);
  const bad  = aggregate(badPosts);

  const chatter     = calcChatter(all,  CHATTER_BASELINES);
  const goodChatter = calcChatter(good, CHATTER_BASELINES);
  const badChatter  = calcChatter(bad,  CHATTER_BASELINES);

  return {
    chatter,
    goodChatter,
    badChatter,
    matchedPosts: matches.length,
    goodPosts:    goodPosts.length,
    badPosts:     badPosts.length,
    likes:        all.likes,
    reposts:      all.reposts,
    replies:      all.replies,
  };
}

function aggregate(posts) {
  let likes = 0, reposts = 0, replies = 0;
  for (const p of posts) {
    likes   += p.likes;
    reposts += p.reposts;
    replies += p.replies;
  }
  return { posts: posts.length, likes, reposts, replies };
}

function anyHit(text, words) {
  for (const w of words) if (text.includes(w)) return true;
  return false;
}

function lastWord(s) {
  if (!s) return '';
  const parts = s.trim().split(/\s+/);
  return parts[parts.length - 1];
}
