// Per-game chatter from Bluesky. Each game gets its own searchPosts query
// against the public AppView — that way the score reflects actual posts about
// THAT game, not a fixed pool divvied across the league. Popular games
// legitimately outscore quiet ones.
//
// Uses sort=top so results are ranked by engagement. Zero-engagement bot posts
// (ABS challenge bots, stat bots, news aggregators) naturally fall out of the
// signal — they never accumulate likes/reposts/replies.
//
// Score per game:
//   engagedCount  — posts where likes+reposts+replies >= 3
//   avgEngagement — mean engagement across those posts
//   chatter       — round(engagedCount * log1p(avgEngagement)), uncapped

import {
  BLUESKY_LIMIT_PER_GAME,
  BLUESKY_SINCE_OFFSET_MS,
} from '../config.js';
import { getAccessJwt, refreshAccessJwt, authConfigured } from './bsky-auth.js';

const ENGAGEMENT_THRESHOLD = 3;

// Note: app.bsky.feed.searchPosts is blocked behind a CDN 403 on
// public.api.bsky.app (anti-scraping), but the same AppView serves it without
// auth on api.bsky.app. Other endpoints (getProfile etc.) work on either.
const APPVIEW = 'https://api.bsky.app/xrpc';
const HEADERS = { 'User-Agent': 'Squeaker/1.0 (squeaker.app)' };

// ── Public ────────────────────────────────────────────────────────────────────

// Fetch + score in one call. Returns null if no posts match.
// Pass { includeSample: true } to get a post snapshot in result.sample
// (used by the live-game sampler in warmup.js — not stored in the peak).
export async function chatterForGame(game, { includeSample = false } = {}) {
  const posts = await searchPosts(game);
  if (posts.length === 0) return null;
  const matches = matchGame(game, posts);
  if (matches.length === 0) return null;
  return scoreChatter(matches, { includeSample });
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

function scoreChatter(matches, { includeSample = false } = {}) {
  const engaged = matches.filter(
    p => p.likes + p.reposts + p.replies >= ENGAGEMENT_THRESHOLD
  );
  const engagedCount = engaged.length;

  let totalEngagement = 0;
  for (const p of engaged) totalEngagement += p.likes + p.reposts + p.replies;
  const avgEngagement = engagedCount > 0 ? totalEngagement / engagedCount : 0;

  const chatter = Math.round(engagedCount * Math.log1p(avgEngagement));

  const result = {
    chatter,
    engagedCount,
    avgEngagement: Math.round(avgEngagement * 10) / 10,
    totalEngagement,
    matchedPosts: matches.length,
  };

  if (includeSample) {
    const engagedSet = new Set(engaged);
    result.sample = [...matches]
      .sort((a, b) => (b.likes + b.reposts + b.replies) - (a.likes + a.reposts + a.replies))
      .map(p => ({
        text:     p.text,
        likes:    p.likes,
        reposts:  p.reposts,
        replies:  p.replies,
        indexedAt: p.indexedAt,
        engaged:  engagedSet.has(p),
      }));
  }

  return result;
}

function lastWord(s) {
  if (!s) return '';
  const parts = s.trim().split(/\s+/);
  return parts[parts.length - 1];
}
