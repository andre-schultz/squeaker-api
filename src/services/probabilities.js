// Win-probability tracking + drama analysis.
//
// We pull the latest WP from ESPN's core API per live game per cycle and
// append to a per-game timeline. Drama is detected by sliding a sport-tuned
// window over the timeline and counting big WP swings + late comebacks.
//
// Soccer (mls/epl/ucl) is intentionally skipped — ESPN doesn't expose WP
// for soccer. NHL coverage is patchy; if a fetch returns nothing we
// silently no-op.

import { setCache, getCache } from './cache.js';
import { CACHE_TTL, WP_WINDOW_MS } from '../config.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports';
const HEADERS = { 'User-Agent': 'Squeaker/1.0' };

// In-memory set of done games we've already snapshotted in this process.
// Once a game is final, its WP timeline is locked — re-polling ESPN and
// re-reading Upstash on every cycle is wasted work. The set resets on
// container restart, which is fine: the next first-cycle re-captures and
// dedup at the snapshot layer prevents duplicate writes.
const doneSnapshotted = new Set();

// ── Public ────────────────────────────────────────────────────────────────────

// Fetch current WP for a game and append to the timeline. Returns the
// updated timeline (or existing one if no fetch was made).
export async function recordWPSnapshot(game, espnSport, espnLeague) {
  // Skip sports we don't track WP for
  if (!WP_WINDOW_MS[game.sport]) return null;
  // Skip pre-game / unknown
  if (!game.live && !game.done) return null;
  // Done games only need to be polled once for their final state
  if (game.done && doneSnapshotted.has(game.id)) return null;

  const current = await fetchCurrentWP(espnSport, espnLeague, game.id);
  if (!current) return await getWPTimeline(game.id);

  const key = `probabilities:${game.id}`;
  const timeline = (await getCache(key)) || [];

  const last = timeline[timeline.length - 1];
  // Only append if WP changed by > 0.5% OR > 60s elapsed (keep timeline thin)
  if (last) {
    const dt = Date.now() - last.t;
    const dwp = Math.abs(current.homeWP - last.homeWP);
    if (dwp < 0.005 && dt < 60_000) return timeline;
  }

  const snapshot = {
    t: Date.now(),
    homeWP: current.homeWP,
    awayWP: current.awayWP,
  };
  timeline.push(snapshot);
  await setCache(key, timeline, CACHE_TTL.probabilities);

  // After capturing a done game once, mark it so we never poll again.
  if (game.done) doneSnapshotted.add(game.id);

  return timeline;
}

export async function getWPTimeline(gameId) {
  return (await getCache(`probabilities:${gameId}`)) || [];
}

// Sport-windowed drama analysis. Returns { dramaBonus, signals, maxSwing }.
export function analyzeWPDrama(timeline, sport) {
  if (!timeline || timeline.length < 2) {
    return { dramaBonus: 0, signals: [], maxSwing: 0 };
  }
  const window = WP_WINDOW_MS[sport];
  if (!window) return { dramaBonus: 0, signals: [], maxSwing: 0 };

  let maxSwing = 0;
  let bigSwingCount = 0;

  // For each snapshot, find the swing vs. the earliest snapshot still
  // within `window` ms in the past.
  for (let i = 1; i < timeline.length; i++) {
    const tNow = timeline[i].t;
    const tStart = tNow - window;
    let earliestIdx = i;
    for (let j = i; j >= 0; j--) {
      if (timeline[j].t < tStart) break;
      earliestIdx = j;
    }
    const swing = Math.abs(timeline[i].homeWP - timeline[earliestIdx].homeWP);
    if (swing > maxSwing) maxSwing = swing;
    if (swing >= 0.25) bigSwingCount++;
  }

  // Late comeback: did the eventual winner's WP dip ≤20% in the final 25%?
  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  const duration = last.t - first.t;
  const lateStart = last.t - duration * 0.25;
  const winnerHome = last.homeWP > 0.5;

  let winnerWPmin = 1.0;
  for (const s of timeline) {
    if (s.t < lateStart) continue;
    const wp = winnerHome ? s.homeWP : s.awayWP;
    if (wp < winnerWPmin) winnerWPmin = wp;
  }

  // Score
  let dramaBonus = 0;
  const signals = [];

  const swingBonus = Math.min(9, bigSwingCount * 3);
  if (swingBonus > 0) {
    dramaBonus += swingBonus;
    signals.push(`${bigSwingCount} dramatic WP swing(s)`);
  }
  if (maxSwing >= 0.4) {
    dramaBonus += 5;
    signals.push('Game-defining WP flip');
  }
  if (winnerWPmin <= 0.20 && timeline.length > 4) {
    dramaBonus += 8;
    signals.push(`Late comeback (winner dipped to ${Math.round(winnerWPmin * 100)}% WP)`);
  }

  return {
    dramaBonus: Math.min(15, dramaBonus),
    signals,
    maxSwing,
  };
}

// "Live action" score — how exciting is the game RIGHT NOW. Looks at WP
// movement in the recent window only, combining three factors:
//
//   • totalSwing       — sum of |Δ WP| across all samples in window
//                        (proxies "how much the game flipped")
//   • maxSingleSwing   — biggest single-step Δ in window
//                        (proxies "did one big play just happen")
//   • directionChanges — count of WP direction reversals
//                        (proxies "back-and-forth chaos")
//
// All three blend into a 0-100 score capped at 100. Returns the breakdown
// alongside the score so audit logs capture enough to fine-tune later.
//
// Returns 0 for done games / empty timelines / pre-game (no recent WP).
export function computeLiveActionBuzz(timeline) {
  const result = {
    score: 0,
    totalSwing: 0,
    maxSingleSwing: 0,
    directionChanges: 0,
    windowSamples: 0,
    windowMs: LIVE_ACTION_WINDOW_MS,
  };

  if (!timeline || timeline.length < 2) return result;

  const now = Date.now();
  const recent = [];
  for (const s of timeline) {
    if (now - s.t < LIVE_ACTION_WINDOW_MS) recent.push(s);
  }
  result.windowSamples = recent.length;
  if (recent.length < 2) return result;

  let lastDir = 0;
  for (let i = 1; i < recent.length; i++) {
    const delta = recent[i].homeWP - recent[i - 1].homeWP;
    const absDelta = Math.abs(delta);
    result.totalSwing += absDelta;
    if (absDelta > result.maxSingleSwing) result.maxSingleSwing = absDelta;

    const dir = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    if (dir !== 0) {
      if (lastDir !== 0 && dir !== lastDir) result.directionChanges++;
      lastDir = dir;
    }
  }

  // 0-100 composite. Calibration:
  //   totalSwing × 150  →  60 pts at 0.40 cumulative WP movement
  //   maxSingle  × 100  →  30 pts at 0.30 max single-step swing
  //   reversals  × 5    →  25 pts at 5 direction changes
  // A truly chaotic, back-and-forth stretch hits 100. A single big play
  // with no reversals lands ~50-60. A quiet stretch stays near 0.
  const raw =
    result.totalSwing * 150 +
    result.maxSingleSwing * 100 +
    result.directionChanges * 5;
  result.score = Math.min(100, Math.round(raw));
  return result;
}

const LIVE_ACTION_WINDOW_MS = 10 * 60 * 1000; // last 10 minutes

// Did an underdog win? Returns { upsetBonus, winnerPreGameWP }.
// Bonus scales linearly: 50% pre-game WP → 0, 0% → 10.
export function analyzeUpset(timeline, game) {
  if (!timeline || timeline.length === 0 || !game.done) {
    return { upsetBonus: 0, winnerPreGameWP: null };
  }
  const winnerHome = game.home.score > game.away.score;
  const earliest = timeline[0];
  const winnerPreGameWP = winnerHome ? earliest.homeWP : earliest.awayWP;
  if (winnerPreGameWP > 0.5) return { upsetBonus: 0, winnerPreGameWP };

  const bonus = Math.min(10, Math.max(0, Math.round((0.5 - winnerPreGameWP) * 20)));
  return { upsetBonus: bonus, winnerPreGameWP };
}

// ── Internals ─────────────────────────────────────────────────────────────────

// Fetch the latest probability entry for a game from ESPN's core API.
// Returns { homeWP, awayWP } in [0,1], or null on miss.
async function fetchCurrentWP(espnSport, espnLeague, eventId) {
  // Pull most-recent first; limit small so we don't waste bandwidth
  const url = `${CORE}/${espnSport}/leagues/${espnLeague}/events/${eventId}/competitions/${eventId}/probabilities?limit=1&page=1`;
  let res;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch (e) {
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

  // First page returns the OLDEST entries; we need the latest. Use the
  // pageCount to fetch the last page.
  const pageCount = data?.pageCount || 1;
  if (pageCount > 1) {
    const lastUrl = `${CORE}/${espnSport}/leagues/${espnLeague}/events/${eventId}/competitions/${eventId}/probabilities?limit=1&page=${pageCount}`;
    try {
      const last = await fetch(lastUrl, { headers: HEADERS });
      if (!last.ok) {
        try { await last.text(); } catch {}
      } else {
        data = await last.json();
      }
    } catch {
      /* fall through with first-page data */
    }
  }

  const entry = data?.items?.[0];
  if (!entry) return null;

  // ESPN returns probabilities as homeWinPercentage / awayWinPercentage.
  // Both are 0–1 floats.
  const homeWP = clamp01(entry.homeWinPercentage);
  const awayWP = clamp01(entry.awayWinPercentage);
  if (homeWP == null || awayWP == null) return null;

  return { homeWP, awayWP };
}

function clamp01(x) {
  if (typeof x !== 'number' || isNaN(x)) return null;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
