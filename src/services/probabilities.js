// Win-probability tracking.
//
// Each cycle we fetch ESPN's full play-by-play WP history for every live or
// recently-finished game and store it (filtered to entries where WP actually
// moved). Using the full history rather than our own 3-minute polling gives
// a richer action signal — every at-bat, power play, or possession that
// shifted the line is captured.
//
// Soccer (mls/epl/ucl/nwsl) is intentionally skipped — ESPN doesn't expose
// WP for soccer. NHL coverage is patchy; if a fetch returns nothing we
// silently no-op.

import { setCache, getCache } from './cache.js';
import { CACHE_TTL, WP_WINDOW_MS } from '../config.js';

const CORE    = 'https://sports.core.api.espn.com/v2/sports';
const HEADERS = { 'User-Agent': 'Squeaker/1.0' };
const PAGE_SIZE = 300; // entries per ESPN probabilities page; most games fit in 1–2 pages

// In-memory set of done games already fetched in this process.
// Once a game is final its WP history is frozen — re-fetching all pages from
// ESPN every cycle is wasted work. Resets on container restart; the
// dedup filter prevents duplicate writes on the first re-fetch.
const doneSnapshotted = new Set();

// ── Public ────────────────────────────────────────────────────────────────────

// Fetch ESPN's full play-by-play WP history for a game and store it.
// Filters out entries where WP didn't actually change to keep the timeline
// clean (ESPN includes many no-change filler entries).
// Returns the filtered timeline, or the cached one if nothing changed.
export async function fetchAndStoreWPTimeline(game, espnSport, espnLeague) {
  if (!WP_WINDOW_MS[game.sport]) return null;
  if (!game.live && !game.done) return null;
  if (game.done && doneSnapshotted.has(game.id)) return getWPTimeline(game.id);

  const raw = await fetchFullESPNTimeline(espnSport, espnLeague, game.id);
  if (!raw.length) return await getWPTimeline(game.id);

  // Filter to entries where homeWP actually moved (removes filler no-change entries)
  const filtered = [];
  for (const entry of raw) {
    const prev = filtered[filtered.length - 1];
    if (!prev || Math.abs(entry.homeWP - prev.homeWP) >= 0.001) {
      filtered.push({ homeWP: entry.homeWP, awayWP: entry.awayWP });
    }
  }

  if (filtered.length) {
    await setCache(`probabilities:${game.id}`, filtered, CACHE_TTL.probabilities);
  }

  if (game.done) doneSnapshotted.add(game.id);
  return filtered;
}

export async function getWPTimeline(gameId) {
  return (await getCache(`probabilities:${gameId}`)) || [];
}

// ── Action score ──────────────────────────────────────────────────────────────
//
// Rate-based formula computed from ESPN's full play-by-play WP timeline.
// All three components are normalised by sample count so the score is
// sport-agnostic — a tense basketball game and a tense baseball game with
// very different play frequencies are judged on intensity per play, not
// total volume.
//
//   avgSwing     — mean |Δ homeWP| per entry. Captures how much each play
//                  moved the needle on average.
//   consecRate   — fraction of adjacent entry-pairs where BOTH deltas exceed
//                  SWING_THRESHOLD. Detects sustained hot streaks.
//   semiRate     — fraction of entry-pairs two steps apart where BOTH exceed
//                  SWING_THRESHOLD. Detects volatile back-and-forth with
//                  brief pauses between big plays.
//
// Sport-specific multipliers. Each sport has different per-play WP dynamics
// (a baseball at-bat moves the needle more than a basketball possession), so
// a single set of multipliers produces skewed cross-sport distributions.
// All sports share the same SWING_THRESHOLD and formula shape; only the
// weights differ so scores are calibrated within each sport's natural range.
// CBB and WCBB intentionally skew low — most games are mismatches — but
// competitive games still reach the high end.
export const SWING_THRESHOLD = 0.03;

export const ACTION_MULTIPLIERS = {
  mlb:  { avgSwing: 800,  consecRate: 60,  semiRate: 40 },
  nba:  { avgSwing: 1200, consecRate: 90,  semiRate: 60 },
  wnba: { avgSwing: 1200, consecRate: 90,  semiRate: 60 },
  nfl:  { avgSwing: 1400, consecRate: 110, semiRate: 70 },
  cfb:  { avgSwing: 1300, consecRate: 100, semiRate: 65 },
  nhl:  { avgSwing: 1100, consecRate: 85,  semiRate: 55 },
  cbb:  { avgSwing: 1600, consecRate: 120, semiRate: 80 },
  wcbb: { avgSwing: 1600, consecRate: 120, semiRate: 80 },
};

export function computeActionScore(timeline, sport) {
  const m = ACTION_MULTIPLIERS[sport] ?? ACTION_MULTIPLIERS.mlb;
  const result = {
    score: 0,
    avgSwing: 0,
    consecRate: 0,
    semiRate: 0,
    samples: timeline?.length ?? 0,
  };

  if (!timeline || timeline.length < 2) return result;

  const deltas = [];
  for (let i = 1; i < timeline.length; i++) {
    deltas.push(Math.abs(timeline[i].homeWP - timeline[i - 1].homeWP));
  }

  const n = deltas.length;
  result.avgSwing = deltas.reduce((a, b) => a + b, 0) / n;

  let consecCount = 0;
  for (let i = 1; i < n; i++) {
    if (deltas[i] >= SWING_THRESHOLD && deltas[i - 1] >= SWING_THRESHOLD) consecCount++;
  }
  result.consecRate = n > 1 ? consecCount / (n - 1) : 0;

  let semiCount = 0;
  for (let i = 2; i < n; i++) {
    if (deltas[i] >= SWING_THRESHOLD && deltas[i - 2] >= SWING_THRESHOLD) semiCount++;
  }
  result.semiRate = n > 2 ? semiCount / (n - 2) : 0;

  const raw =
    result.avgSwing   * m.avgSwing +
    result.consecRate * m.consecRate +
    result.semiRate   * m.semiRate;

  result.score = Math.min(100, Math.round(raw));
  return result;
}

// Did an underdog win? Returns { upsetBonus, winnerPreGameWP }.
// Bonus scales linearly: 50% pre-game WP → 0, 0% → 10.
export function analyzeUpset(timeline, game) {
  if (!timeline || timeline.length === 0 || !game.done) {
    return { upsetBonus: 0, winnerPreGameWP: null };
  }
  const winnerHome      = game.home.score > game.away.score;
  const earliest        = timeline[0];
  const winnerPreGameWP = winnerHome ? earliest.homeWP : earliest.awayWP;
  if (winnerPreGameWP > 0.5) return { upsetBonus: 0, winnerPreGameWP };

  const bonus = Math.min(10, Math.max(0, Math.round((0.5 - winnerPreGameWP) * 20)));
  return { upsetBonus: bonus, winnerPreGameWP };
}

// ── Internals ─────────────────────────────────────────────────────────────────

// Fetch all pages of ESPN's play-by-play probability history for a game.
// Returns [{ homeWP, awayWP }, …] in chronological order, or [] on failure.
async function fetchFullESPNTimeline(espnSport, espnLeague, eventId) {
  const base = `${CORE}/${espnSport}/leagues/${espnLeague}/events/${eventId}/competitions/${eventId}/probabilities`;

  let data;
  try {
    const res = await fetch(`${base}?limit=${PAGE_SIZE}&page=1`, { headers: HEADERS });
    if (!res.ok) { try { await res.text(); } catch {} return []; }
    data = await res.json();
  } catch { return []; }

  if (!data?.items?.length) return [];

  const pageCount = data.pageCount || 1;
  const allItems  = [...data.items];

  if (pageCount > 1) {
    const pages = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) =>
        fetch(`${base}?limit=${PAGE_SIZE}&page=${i + 2}`, { headers: HEADERS })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );
    for (const page of pages) {
      if (page?.items) allItems.push(...page.items);
    }
  }

  return allItems
    .filter(e => e.homeWinPercentage != null && e.awayWinPercentage != null)
    .map(e => ({
      homeWP: clamp01(e.homeWinPercentage),
      awayWP: clamp01(e.awayWinPercentage),
    }))
    .filter(e => e.homeWP != null && e.awayWP != null);
}

function clamp01(x) {
  if (typeof x !== 'number' || isNaN(x)) return null;
  return Math.max(0, Math.min(1, x));
}

// ── Moneyline → win-probability helpers ───────────────────────────────────────
// Used to derive a pre-game win probability from ESPN's frozen money line when
// a play-by-play WP timeline was never recorded (upset-detection fallback in
// espn.js).

function mlToRawProb(ml) {
  if (typeof ml !== 'number' || ml === 0) return null;
  return ml > 0 ? 100 / (ml + 100) : (-ml) / (-ml + 100);
}

// Convert a home+away ML pair to vig-normalised [0,1] probabilities so
// homeWP + awayWP = 1.0 regardless of the book's margin.
export function mlPairToWP(homeML, awayML) {
  const rawHome = mlToRawProb(homeML);
  const rawAway = mlToRawProb(awayML);
  if (rawHome == null || rawAway == null) return null;
  const total = rawHome + rawAway;
  if (total === 0) return null;
  return { homeWP: rawHome / total, awayWP: rawAway / total };
}
