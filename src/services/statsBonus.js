import { setCache, getCache } from './cache.js';

const BONUS_TTL = 7 * 24 * 60 * 60; // 7 days
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

function sum(a, b) {
  return (a || 0) + (b || 0);
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
    shots:       nr(sum(home.shotsTotal, away.shotsTotal), 55, 70),
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

function nba(s, totalScore) {
  const { home, away } = s;
  const THREE_KEY = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';
  const stats = {
    points:        nr(totalScore, 211, 250),
    threePointers: nr(sum(home[THREE_KEY], away[THREE_KEY]), 20, 31),
    stealsBlocks:  nr(sum(home.steals, away.steals) + sum(home.blocks, away.blocks), 20, 31),
  };
  const weights = { points: 0.20, threePointers: 0.45, stealsBlocks: 0.35 };
  return weighted(stats, weights);
}

function wnba(s, totalScore) {
  const { home, away } = s;
  const THREE_KEY = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';
  const stats = {
    points:        nr(totalScore, 140, 180),
    threePointers: nr(sum(home[THREE_KEY], away[THREE_KEY]), 10, 21),
    stealsBlocks:  nr(sum(home.steals, away.steals) + sum(home.blocks, away.blocks), 17, 26),
  };
  const weights = { points: 0.20, threePointers: 0.45, stealsBlocks: 0.35 };
  return weighted(stats, weights);
}

function cbb(s, totalScore) {
  const { home, away } = s;
  const THREE_KEY = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';
  const stats = {
    points:        nr(totalScore, 131, 169),
    threePointers: nr(sum(home[THREE_KEY], away[THREE_KEY]), 12, 20),
    stealsBlocks:  nr(sum(home.steals, away.steals) + sum(home.blocks, away.blocks), 14, 25),
  };
  const weights = { points: 0.20, threePointers: 0.45, stealsBlocks: 0.35 };
  return weighted(stats, weights);
}

function wcbb(s, totalScore) {
  const { home, away } = s;
  const THREE_KEY = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';
  const stats = {
    points:        nr(totalScore, 116, 154),
    threePointers: nr(sum(home[THREE_KEY], away[THREE_KEY]), 8, 17),
    stealsBlocks:  nr(sum(home.steals, away.steals) + sum(home.blocks, away.blocks), 17, 30),
  };
  const weights = { points: 0.20, threePointers: 0.45, stealsBlocks: 0.35 };
  return weighted(stats, weights);
}

function nfl(s, totalScore) {
  const { home, away } = s;
  const stats = {
    points:     nr(totalScore, 25, 57),
    turnovers:  nr(sum(home.interceptions, away.interceptions) + sum(home.fumbles, away.fumbles), 0, 3),
    firstDowns: nr(sum(home.firstDowns, away.firstDowns), 28, 46),
    yards:      nr(sum(home.totalYards, away.totalYards), 480, 770),
  };
  const weights = { points: 0.25, turnovers: 0.35, firstDowns: 0.20, yards: 0.20 };
  return weighted(stats, weights);
}

function cfb(s, totalScore) {
  const { home, away } = s;
  const stats = {
    points:     nr(totalScore, 28, 67),
    turnovers:  nr(sum(home.interceptions, away.interceptions) + sum(home.fumbles, away.fumbles), 0, 3),
    firstDowns: nr(sum(home.firstDowns, away.firstDowns), 29, 46),
    yards:      nr(sum(home.totalYards, away.totalYards), 550, 875),
  };
  const weights = { points: 0.25, turnovers: 0.35, firstDowns: 0.20, yards: 0.20 };
  return weighted(stats, weights);
}

function weighted(stats, weights) {
  const score = Math.max(1, Math.round(
    Object.entries(weights).reduce((acc, [k, w]) => acc + (stats[k] || 0) * w, 0) * MAX_BONUS
  ));
  return { score, breakdown: stats };
}

const BY_SPORT = {
  epl: soccer, mls: soccer, ucl: soccer, nwsl: soccer,
  nhl,
  mlb,
  nba,
  wnba,
  cbb,
  wcbb,
  nfl,
  cfb,
};

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
  };

  await setCache(`stats-bonus:${game.id}`, record, BONUS_TTL);
  return record;
}

export async function getStatsBonus(gameId) {
  return await getCache(`stats-bonus:${gameId}`) || null;
}
