// Odds: one-shot fetch + cache, no time-series tracking.
//
// We grab a game's pre-game line once on first sighting and freeze it
// alongside the game record. The frozen value is what the UI displays
// (spread + over/under in the corner of the card). ESPN's /odds endpoint
// doesn't expose live in-play movement publicly, so polling repeatedly
// returns the same closing line — pointless work. The "is this game
// exciting right now?" signal comes from win-probability volatility
// (see liveActionBuzz in probabilities.js) instead.

import { setCache, getCache } from './cache.js';
import { CACHE_TTL } from '../config.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports';
const HEADERS = { 'User-Agent': 'Squeaker/1.0' };

// In-memory odds cache — once an odds record is loaded from Redis or fetched
// from ESPN it lives here for the lifetime of the process. Odds never change
// once a game starts, so there is no need to ever re-read them from Redis.
// null is also stored (meaning ESPN had no odds) so we don't re-fetch those either.
const _memOdds = new Map(); // gameId → odds object | null

// Get the frozen odds for a game.
//   1. Return from in-memory cache (0 Redis ops) — the common path each cycle.
//   2. Load from Redis (1 GET) — first call after a process restart.
//   3. Fetch from ESPN + persist to Redis (1 GET + 1 SET) — very first time ever.
export async function getOrFetchOdds(gameId, espnSport, espnLeague) {
  if (_memOdds.has(gameId)) return _memOdds.get(gameId);

  const key = `gameOdds:${gameId}`;
  const cached = await getCache(key);
  if (cached) {
    _memOdds.set(gameId, cached);
    return cached;
  }

  const fetched = await fetchCurrentOdds(espnSport, espnLeague, gameId);
  _memOdds.set(gameId, fetched ?? null); // cache null so we don't re-fetch
  if (fetched) await setCache(key, fetched, CACHE_TTL.frozenOdds);
  return fetched ?? null;
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function fetchCurrentOdds(espnSport, espnLeague, eventId) {
  const url = `${CORE}/${espnSport}/leagues/${espnLeague}/events/${eventId}/competitions/${eventId}/odds`;
  let res;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch {
    return null;
  }
  if (!res.ok) {
    try { await res.text(); } catch {}
    return null;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  const entry = data?.items?.[0];
  if (!entry) return null;

  return {
    provider:  entry.provider?.name || null,
    spread:    typeof entry.spread === 'number' ? entry.spread : null,
    overUnder: typeof entry.overUnder === 'number' ? entry.overUnder : null,
    homeML:    entry.homeTeamOdds?.moneyLine ?? null,
    awayML:    entry.awayTeamOdds?.moneyLine ?? null,
    favorite:  entry.homeTeamOdds?.favorite ? 'home'
             : entry.awayTeamOdds?.favorite ? 'away'
             : null,
    details:   entry.details || null,
    capturedAt: new Date().toISOString(),
  };
}
