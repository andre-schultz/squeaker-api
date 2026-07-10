import { setCache, getCache } from './cache.js';
import { CACHE_TTL } from '../config.js';
import { sum, THREE_KEY } from './util.js';

const MAX_BONUS = 15;

// Range-normalize: maps [floor, ceiling] → [0, 1.35], clamped.
// floor   = realistic minimum for a below-average game
// ceiling = ~p90 of real games (top ~10% hit or exceed it, scoring near 15)
// Values above the ceiling can score up to 1.35, boosting the max stats
// bonus from 15 to ~20. Values at or below the ceiling are unaffected.
// Values for stats that naturally start at 0 use floor=0.
function nr(value, floor, ceiling) {
  return Math.max(0, Math.min(1.35, ((value || 0) - floor) / (ceiling - floor)));
}

// Each sport function returns a score 1–15 and a breakdown of normalised components.
// totalScore = home.score + away.score passed in from the game object.

function soccer(s, totalScore) {
  const { home, away } = s;
  const stats = {
    goals:         nr(totalScore, 0, 4),
    shots:         nr(sum(home.totalShots, away.totalShots), 10, 32),
    shotsOnTarget: nr(sum(home.shotsOnTarget, away.shotsOnTarget), 2, 13),
    cards:         nr(sum(home.yellowCards, away.yellowCards) + sum(home.redCards, away.redCards), 0, 7),
    corners:       nr(sum(home.wonCorners, away.wonCorners), 3, 16),
  };
  const weights = { goals: 0.25, shots: 0.25, shotsOnTarget: 0.25, cards: 0.15, corners: 0.10 };
  return weighted(stats, weights);
}

function nhl(s, totalScore) {
  const { home, away } = s;
  const stats = {
    goals:       nr(totalScore, 0, 6),
    shots:       nr(sum(home.shotsTotal, away.shotsTotal), 45, 75),
    hits:        nr(sum(home.hits, away.hits), 45, 70),
    powerPlays:  nr(sum(home.powerPlayOpportunities, away.powerPlayOpportunities), 2, 9),
  };
  const weights = { goals: 0.25, shots: 0.35, hits: 0.25, powerPlays: 0.15 };
  return weighted(stats, weights);
}

function mlb(s, totalScore) {
  const { home, away } = s;
  const stats = {
    runs:          nr(totalScore, 0, 14),
    hits:          nr(sum(home.batting_hits, away.batting_hits), 5, 21),
    homeRuns:      nr(sum(home.batting_homeRuns, away.batting_homeRuns), 0, 4),
    extraBaseHits: nr(sum(home.batting_extraBaseHits, away.batting_extraBaseHits), 1, 10),
    stolenBases:   nr(sum(home.batting_stolenBases, away.batting_stolenBases), 0, 4),
    errors:        nr(sum(home.fielding_errors, away.fielding_errors), 0, 2),
  };
  const weights = { runs: 0.20, hits: 0.15, homeRuns: 0.25, extraBaseHits: 0.20, stolenBases: 0.10, errors: 0.10 };
  return weighted(stats, weights);
}

// Basketball and football share one formula per family; only the [floor,
// ceiling] normalization bounds differ per league. Recalibrating a league is a
// bounds-table edit, not a code change.
const BASKETBALL_BOUNDS = {
  nba:  { points: [211, 250], threePointers: [20, 31], stealsBlocks: [20, 31] },
  wnba: { points: [140, 180], threePointers: [10, 21], stealsBlocks: [17, 26] },
  cbb:  { points: [131, 169], threePointers: [12, 20], stealsBlocks: [14, 25] },
  wcbb: { points: [116, 154], threePointers: [8, 17],  stealsBlocks: [17, 30] },
};
const BASKETBALL_WEIGHTS = { points: 0.20, threePointers: 0.45, stealsBlocks: 0.35 };

function basketball(bounds) {
  return (s, totalScore) => {
    const { home, away } = s;
    const stats = {
      points:        nr(totalScore, ...bounds.points),
      threePointers: nr(sum(home[THREE_KEY], away[THREE_KEY]), ...bounds.threePointers),
      stealsBlocks:  nr(sum(home.steals, away.steals) + sum(home.blocks, away.blocks), ...bounds.stealsBlocks),
    };
    return weighted(stats, BASKETBALL_WEIGHTS);
  };
}

const FOOTBALL_BOUNDS = {
  nfl: { points: [25, 57], turnovers: [0, 3], firstDowns: [28, 46], yards: [480, 770] },
  cfb: { points: [28, 67], turnovers: [0, 3], firstDowns: [29, 46], yards: [550, 875] },
};
const FOOTBALL_WEIGHTS = { points: 0.25, turnovers: 0.35, firstDowns: 0.20, yards: 0.20 };

function football(bounds) {
  return (s, totalScore) => {
    const { home, away } = s;
    const stats = {
      points:     nr(totalScore, ...bounds.points),
      turnovers:  nr(sum(home.interceptions, away.interceptions) + sum(home.fumbles, away.fumbles), ...bounds.turnovers),
      firstDowns: nr(sum(home.firstDowns, away.firstDowns), ...bounds.firstDowns),
      yards:      nr(sum(home.totalYards, away.totalYards), ...bounds.yards),
    };
    return weighted(stats, FOOTBALL_WEIGHTS);
  };
}

function weighted(stats, weights) {
  const score = Math.max(1, Math.round(
    Object.entries(weights).reduce((acc, [k, w]) => acc + (stats[k] || 0) * w, 0) * MAX_BONUS
  ));
  return { score, breakdown: stats };
}

const BY_SPORT = {
  epl: soccer, mls: soccer, ucl: soccer, nwsl: soccer, intl: soccer, wc: soccer,
  nhl,
  mlb,
  nba:  basketball(BASKETBALL_BOUNDS.nba),
  wnba: basketball(BASKETBALL_BOUNDS.wnba),
  cbb:  basketball(BASKETBALL_BOUNDS.cbb),
  wcbb: basketball(BASKETBALL_BOUNDS.wcbb),
  nfl:  football(FOOTBALL_BOUNDS.nfl),
  cfb:  football(FOOTBALL_BOUNDS.cfb),
};

// Pure stats-activity bonus for a sport from a parsed stats snapshot. No Redis,
// no network — exposed so offline tools (the historical rescore) compute the
// exact production value. Returns { score, breakdown } or null for sports with
// no stats formula.
export function computeStatsBonus(sport, statsSnapshot, totalScore) {
  const compute = BY_SPORT[sport];
  if (!compute) return null;
  return compute(statsSnapshot, totalScore);
}

// Compute activity bonus from a stats snapshot and store to Redis.
// Overwrites on every stats cycle so live games get updated values as the game progresses.
// Done games are stable — overwriting with the same data is harmless.
export async function recordStatsBonus(game, statsSnapshot) {
  const compute = BY_SPORT[game.sport];
  if (!compute) return null;

  const totalScore = (game.home?.score ?? 0) + (game.away?.score ?? 0);
  const result = compute(statsSnapshot, totalScore);
  const record = {
    t:         Date.now(),
    sport:     game.sport,
    score:     result.score,
    breakdown: result.breakdown,
    // Empty-net goal counts piggyback on this record so the scoring cycle, which
    // already reads stats-bonus, can compute an ENG-adjusted closeness margin
    // without a second Redis read or its own /summary fetch.
    emptyNet:  statsSnapshot?.emptyNet ?? { home: 0, away: 0 },
    // Basketball scoring-run momentum, likewise computed from play-by-play here
    // and read back by the scoring cycle to fold into the momentum bonus.
    runs:      statsSnapshot?.runs ?? null,
  };

  await setCache(`stats-bonus:${game.id}`, record, CACHE_TTL.statsBonus);
  return record;
}

export async function getStatsBonus(gameId) {
  return await getCache(`stats-bonus:${gameId}`) || null;
}
