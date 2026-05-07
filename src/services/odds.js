// Odds + line-movement tracking. Stored separately from excitement —
// betting flow is a money signal, not a drama signal. The frontend can
// surface "line moved 4 points" as its own indicator alongside articles
// and (eventually) Reddit buzz.
//
// We capture:
//   • opening line — first odds we see for a game
//   • current line — latest odds
//   • history — sparse timeline of line changes during/after the game
//   • bettingBuzz — single 0-100 score for display, derived from total
//                   spread shift + number of meaningful moves. Frozen at
//                   game end so the post-game number is stable.

import { setCache, getCache } from './cache.js';
import { CACHE_TTL } from '../config.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports';
const HEADERS = { 'User-Agent': 'Squeaker/1.0' };

// Minimum changes to record a new history entry (avoid noise from quote
// providers churning back and forth on small ticks). Tuned after observing
// that real moves often happen on the moneyline alone — books frequently
// adjust juice without nudging the spread number.
const SPREAD_DELTA = 0.25;
const TOTAL_DELTA = 0.5;
const ML_DELTA = 5;

// ── Public ────────────────────────────────────────────────────────────────────

export async function recordOdds(game, espnSport, espnLeague) {
  const current = await fetchCurrentOdds(espnSport, espnLeague, game.id);
  if (!current) return null;

  const key = `odds:${game.id}`;
  const existing = (await getCache(key)) || {
    opening:     null,
    current:     null,
    history:     [],
    bettingBuzz: 0,
  };

  // Capture opening line on first sight
  if (!existing.opening) existing.opening = { ...current, t: Date.now() };

  // Record history entry only if line moved meaningfully on ANY axis —
  // spread, total, or either moneyline. Books often shift only ML when
  // public money is one-sided, so spread-only detection misses real action.
  const last = existing.current;
  const moved =
    !last ||
    Math.abs((current.spread    ?? 0) - (last.spread    ?? 0)) >= SPREAD_DELTA ||
    Math.abs((current.overUnder ?? 0) - (last.overUnder ?? 0)) >= TOTAL_DELTA ||
    Math.abs((current.homeML    ?? 0) - (last.homeML    ?? 0)) >= ML_DELTA ||
    Math.abs((current.awayML    ?? 0) - (last.awayML    ?? 0)) >= ML_DELTA;

  if (moved) {
    existing.history.push({ ...current, t: Date.now() });
    // Keep history bounded — last 50 movements is plenty
    if (existing.history.length > 50) existing.history.splice(0, existing.history.length - 50);
  }

  existing.current = { ...current, t: Date.now() };

  // Single 0-100 score for the frontend. Frozen once the game ends so the
  // post-game display value doesn't drift if a book regrades the line. The
  // first time we see a done game without a stored value, compute once.
  if (!game.done || existing.bettingBuzz == null) {
    existing.bettingBuzz = computeBettingBuzz(existing);
  }

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

// 0-100 single-number summary of line-movement intensity.
//
//   spreadShift × 15  →  total magnitude of spread movement
//   totalShift  × 5   →  movement on the over/under
//   mlShift     × 0.5 →  juice movement (per cent of ML shift)
//   moveCount   × 8   →  volatility / number of meaningful moves
//
// Includes ML so spread-stable / juice-only moves still register —
// common pattern when books prefer to adjust juice over moving the number.
//
// Examples (using opening as the baseline):
//   Line never moved:                                              0
//   Juice-only (ML -150 → -180, 1 move):                          23
//   Quiet drift (spread -3 → -3.5, ML -150 → -160, 1 move):       21
//   Steady money (spread -7 → -10, ML -200 → -250, 4 moves):     100 (capped)
//   Whiplash (spread -3 → +2, ML +130 → -180, 6 moves):          100 (capped)
function computeBettingBuzz({ opening, current, history }) {
  if (!opening || !current) return 0;
  const spreadShift = Math.abs((current.spread    ?? 0) - (opening.spread    ?? 0));
  const totalShift  = Math.abs((current.overUnder ?? 0) - (opening.overUnder ?? 0));
  const mlShift     = Math.abs((current.homeML    ?? 0) - (opening.homeML    ?? 0));
  const moveCount   = Math.max(0, (history?.length ?? 0) - 1);
  return Math.min(
    100,
    Math.round(
      spreadShift * 15 +
      totalShift  * 5  +
      mlShift     * 0.5 +
      moveCount   * 8
    )
  );
}
