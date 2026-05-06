// ESPN article tracking. Polls each league's news feed once per cycle and
// matches articles to games by:
//   1. Explicit event-id references in article.categories (most reliable)
//   2. Team-id references in article.categories (fallback)
//   3. Team-name text match in headline (last-resort fallback)
//
// We deliberately don't compute a buzz score from this — articles are an
// editorial signal (what ESPN's editors think is notable), separate from
// fan engagement. Stored under articles:${gameId} as { count, articles[] }
// so the frontend can render them independently.

import { SPORTS, CACHE_TTL } from '../config.js';
import { setCache, getCache } from './cache.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const NEWS_LIMIT = 50;
const HEADERS = { 'User-Agent': 'Squeaker/1.0' };

// ── Public ────────────────────────────────────────────────────────────────────

// Fetch the news feed from every league. Returns a flat array of normalized
// articles with cross-references to event ids and team ids.
export async function fetchAllArticles() {
  const all = [];
  // Dedupe by espnSport+espnLeague — some sports share an endpoint.
  const seen = new Set();
  for (const cfg of Object.values(SPORTS)) {
    const key = `${cfg.espnSport}/${cfg.espnLeague}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const articles = await fetchLeagueArticles(cfg.espnSport, cfg.espnLeague);
    for (const a of articles) all.push(a);
  }
  return all;
}

// Match articles to a game. Returns the matched article objects.
export function articlesForGame(game, articles) {
  const gameId = String(game.id);
  const homeAbbr = game.home.abbr.toLowerCase();
  const awayAbbr = game.away.abbr.toLowerCase();
  const homeLast = game.home.name.split(' ').pop().toLowerCase();
  const awayLast = game.away.name.split(' ').pop().toLowerCase();

  const out = [];
  for (const a of articles) {
    if (a.eventIds.includes(gameId)) {
      out.push(a);
      continue;
    }
    // Headline must mention BOTH teams to count as a per-game match
    // (a generic team article doesn't count).
    const h = a.headlineLower;
    const home = h.includes(homeLast) || h.includes(homeAbbr);
    const away = h.includes(awayLast) || h.includes(awayAbbr);
    if (home && away) out.push(a);
  }
  return out;
}

// Update the cached article record for a game. Always writes (even on empty)
// so stale records eventually clear, with a TTL aligned to game freshness.
export async function updateGameArticles(game, matched) {
  const key = `articles:${game.id}`;
  const ttl = game.live ? CACHE_TTL.articlesLive : CACHE_TTL.articles;
  const record = {
    count: matched.length,
    articles: matched.map(stripForCache),
    recordedAt: new Date().toISOString(),
  };
  await setCache(key, record, ttl);
  return record;
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function fetchLeagueArticles(sport, league) {
  const url = `${BASE}/${sport}/${league}/news?limit=${NEWS_LIMIT}`;
  let res;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch (e) {
    console.error(`[articles] ${sport}/${league} fetch error: ${e.message}`);
    return [];
  }
  if (!res.ok) {
    console.warn(`[articles] ${sport}/${league} HTTP ${res.status}`);
    try { await res.text(); } catch {}
    return [];
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.error(`[articles] ${sport}/${league} JSON parse failed: ${e.message}`);
    return [];
  }

  const items = data?.articles || data?.headlines || [];
  const out = [];
  for (const a of items) {
    const norm = normalizeArticle(a, sport, league);
    if (norm) out.push(norm);
  }
  data = null;
  console.log(`[articles] ${sport}/${league}: ${out.length} articles`);
  return out;
}

// Normalize an ESPN article to a stable shape. ESPN's news API has slightly
// different shapes across sports — this function handles both common forms.
function normalizeArticle(a, sport, league) {
  if (!a) return null;
  const headline = a.headline || a.title;
  if (!headline) return null;
  const url =
    a.links?.web?.href ||
    a.links?.api?.news?.href ||
    a.url ||
    null;
  if (!url) return null;

  const eventIds = [];
  const teamIds = [];
  for (const cat of a.categories || []) {
    if (cat?.type === 'event' && cat.eventId != null) eventIds.push(String(cat.eventId));
    if (cat?.type === 'team' && cat.teamId != null) teamIds.push(String(cat.teamId));
    // Older shape uses athlete/league/team without nested ids
    if (cat?.event?.id != null) eventIds.push(String(cat.event.id));
    if (cat?.team?.id != null) teamIds.push(String(cat.team.id));
  }

  return {
    sport,
    league,
    headline,
    headlineLower: headline.toLowerCase(),
    description: a.description || '',
    type: a.type || 'Story',
    url,
    image: a.images?.[0]?.url || null,
    published: a.published || null,
    eventIds,
    teamIds,
  };
}

// What we actually persist. Drops the helper fields used only for matching.
function stripForCache(a) {
  return {
    headline: a.headline,
    description: a.description,
    type: a.type,
    url: a.url,
    image: a.image,
    published: a.published,
    sport: a.sport,
    league: a.league,
  };
}
