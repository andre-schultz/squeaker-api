// Bulk-poll model: rather than searching Reddit per-game (slow, noisy, hits
// rate limits), we pull a single hot.json page from each tracked subreddit
// per cycle and match the returned posts against the games we already know
// about. One subreddit fetch covers all games being discussed in that sub.
//
// Sentiment is derived from post titles (good vs boring keyword hits). We
// don't fetch comments per game — that's where the old model burned through
// API budget for thin signal.

import {
  REDDIT_SUBS,
  REDDIT_POSTS_PER_SUB,
  EXCITEMENT_WORDS,
  BORING_WORDS,
  SPORTS,
} from '../config.js';
import { calcBuzz } from './algorithm.js';

const HEADERS = { 'User-Agent': 'Squeaker/1.0 (squeaker.app)' };
const POLL_DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Public ────────────────────────────────────────────────────────────────────

// Fetch hot posts from every tracked subreddit. Returns a flat array of
// normalized posts. Errors per-sub are swallowed so one bad sub doesn't kill
// the cycle.
export async function fetchAllPosts() {
  const out = [];
  for (const sub of REDDIT_SUBS) {
    const posts = await fetchSubreddit(sub);
    for (const p of posts) out.push(p);
    await sleep(POLL_DELAY_MS);
  }
  return out;
}

// Compute current buzz for a single game from the post pool. Returns null if
// no posts match.
export function buzzForGame(game, posts) {
  const matches = matchGame(game, posts);
  if (matches.length === 0) return null;
  return scoreBuzz(game, matches);
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function fetchSubreddit(sub) {
  const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${REDDIT_POSTS_PER_SUB}`;
  let res;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch (e) {
    console.error(`[reddit] r/${sub} fetch error: ${e.message}`);
    return [];
  }

  if (res.status === 429) {
    console.warn(`[reddit] r/${sub} 429 rate-limited`);
    await drain(res);
    return [];
  }
  if (!res.ok) {
    console.warn(`[reddit] r/${sub} HTTP ${res.status}`);
    await drain(res);
    return [];
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.error(`[reddit] r/${sub} JSON parse failed: ${e.message}`);
    return [];
  }

  const children = data?.data?.children || [];
  const posts = [];
  for (const c of children) {
    const p = normalizePost(c?.data, sub);
    if (p) posts.push(p);
  }
  // Drop the parsed payload reference so the GC can reclaim it before we
  // move on to the next subreddit. (Belt-and-suspenders against the leak.)
  data = null;
  console.log(`[reddit] r/${sub}: ${posts.length} posts`);
  return posts;
}

// Make sure response bodies are always read so the underlying socket
// is released. Critical with native undici fetch.
async function drain(res) {
  try {
    await res.text();
  } catch {
    /* ignore */
  }
}

function normalizePost(p, sub) {
  if (!p?.title || !p.permalink) return null;
  return {
    subreddit: sub,
    title: p.title,
    titleLower: p.title.toLowerCase(),
    score: p.score | 0,
    comments: p.num_comments | 0,
    created_utc: p.created_utc || 0,
    permalink: p.permalink,
  };
}

// ── Matching ──────────────────────────────────────────────────────────────────

function matchGame(game, posts) {
  const homeFull = (game.home.fullName || game.home.name).toLowerCase();
  const awayFull = (game.away.fullName || game.away.name).toLowerCase();
  const homeAbbr = game.home.abbr.toLowerCase();
  const awayAbbr = game.away.abbr.toLowerCase();
  const homeLast = game.home.name.split(' ').pop().toLowerCase();
  const awayLast = game.away.name.split(' ').pop().toLowerCase();

  // Title must mention BOTH teams (any of full / last-word / abbr) AND have
  // been posted within the game's plausible window (1h before → 5h after).
  const gameTs = game.date ? new Date(game.date).getTime() / 1000 : null;
  const winStart = gameTs ? gameTs - 3600 : null;
  const winEnd = gameTs ? gameTs + 18000 : null;

  const out = [];
  for (const p of posts) {
    if (winStart !== null && (p.created_utc < winStart || p.created_utc > winEnd)) continue;
    const t = p.titleLower;
    const home = t.includes(homeLast) || t.includes(homeAbbr) || t.includes(homeFull);
    const away = t.includes(awayLast) || t.includes(awayAbbr) || t.includes(awayFull);
    if (home && away) out.push(p);
  }
  return out;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreBuzz(game, matches) {
  const sportCfg = SPORTS[game.sport] || {
    base: { comments: 1000, upvotes: 200, velocity: 200 },
  };

  // Aggregate engagement across every matched post (a game can have a Game
  // Thread + Post-Game Thread + reactions in r/sports etc.)
  let comments = 0;
  let upvotes = 0;
  let earliest = Infinity;
  let topPost = matches[0];
  for (const p of matches) {
    comments += p.comments;
    upvotes += p.score;
    if (p.created_utc && p.created_utc < earliest) earliest = p.created_utc;
    if (p.comments > topPost.comments) topPost = p;
  }

  const now = Date.now() / 1000;
  const hrs = earliest === Infinity ? 1 : Math.max(0.25, (now - earliest) / 3600);
  const velocity = Math.round(comments / hrs);

  // Sentiment from titles only — fast, no extra HTTP. Captures the broad
  // tone of how the game is being discussed.
  const titles = matches.map((p) => p.titleLower).join(' ');
  const good = countHits(titles, EXCITEMENT_WORDS);
  const bad = countHits(titles, BORING_WORDS);
  const total = good + bad;
  const sentiment = total === 0 ? 50 : Math.round((good / total) * 100);

  const buzz = calcBuzz(
    { comments, upvotes, velocity, sentiment, isLive: game.live },
    sportCfg
  );

  // Split out positive and negative buzz so the UI can show both poles.
  // Both can be high simultaneously — that's a "passionate" game.
  const goodBuzz = total === 0 ? 0 : Math.round(buzz * (good / total));
  const badBuzz = total === 0 ? 0 : Math.round(buzz * (bad / total));

  return {
    buzz,
    goodBuzz,
    badBuzz,
    comments,
    upvotes,
    velocity,
    sentiment,
    matchedPosts: matches.length,
    threadUrl: `https://reddit.com${topPost.permalink}`,
  };
}

function countHits(text, words) {
  let n = 0;
  for (const w of words) {
    const hit = /\p{Emoji}/u.test(w) || w.includes(' ')
      ? text.includes(w)
      : new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
    if (hit) n++;
  }
  return n;
}
