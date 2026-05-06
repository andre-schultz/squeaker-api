// Odds + line-movement tracking. Stored separately from excitement —
// betting flow is a money signal, not a drama signal. The frontend can
// surface "line moved 4 points" as its own indicator alongside articles
// and (eventually) Reddit buzz.
//
// We capture:
//   • opening line — first odds we see for a game
//   • current line — latest odds
//   • history — sparse timeline of line changes during/after the game

import { setCache, getCache } from './cache.js';
import { CACHE_TTL } from '../config.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports';
const HEADERS = { 'User-Agent': 'Squeaker/1.0' };

// Minimum changes to record a new history entry (avoid noise from quote
// providers churning by 0.5 every minute):
const SPREAD_DELTA = 0.5;
const TOTAL_DELTA = 0.5;

// ── Public ────────────────────────────────────────────────────────────────────

export async function recordOdds(game, espnSport, espnLeague) {
  const current = await fetchCurrentOdds(espnSport, espnLeague, game.id);
  if (!current) return null;

  const key = `odds:${game.id}`;
  const existing = (await getCache(key)) || { opening: null, current: null, history: [] };

  // Capture opening line on first sight
  if (!existing.opening) existing.opening = { ...current, t: Date.now() };

  // Record history entry only if line moved meaningfully
  const last = existing.current;
  const moved =
    !last ||
    Math.abs((current.spread ?? 0) - (last.spread ?? 0)) >= SPREAD_DELTA ||
    Math.abs((current.overUnder ?? 0) - (last.overUnder ?? 0)) >= TOTAL_DELTA;

  if (moved) {
    existing.history.push({ ...current, t: Date.now() });
    // Keep history bounded — last 50 movements is plenty
    if (existing.history.length > 50) existing.history.splice(0, existing.history.length - 50);
  }

  existing.current = { ...current, t: Date.now() };
  await setCache(key, existing, CACHE_TTL.odds);
  return existing;
}

export async function getOdds(gameId) {
  return await getCache(`odds:${gameId}`);
}

// ── Internals ─────────────────────────────────────────────────────────────────

// Pull the consensus odds entry from ESPN. Returns null if unavailable.
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

  // ESPN returns multiple provider entries; first item is usually the
  // consensus. We just take the first valid one.
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
  };
}
