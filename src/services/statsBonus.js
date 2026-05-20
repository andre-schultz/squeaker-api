import { setCache, getCache } from './cache.js';

const BONUS_TTL = 7 * 24 * 60 * 60; // 7 days
const MAX_BONUS = 15;

// Normalize a value against a baseline, capped at 1.0.
function norm(value, baseline) {
  return Math.min(1, (value || 0) / baseline);
}

function sum(a, b) {
  return (a || 0) + (b || 0);
}

// Each sport function returns a score 0–15 and a breakdown of what contributed.
function soccer(s) {
  const { home, away } = s;
  const stats = {
    shots:         norm(sum(home.totalShots, away.totalShots), 30),
    shotsOnTarget: norm(sum(home.shotsOnTarget, away.shotsOnTarget), 10),
    cards:         norm(sum(home.yellowCards, away.yellowCards) + sum(home.redCards, away.redCards), 5),
    corners:       norm(sum(home.wonCorners, away.wonCorners), 14),
  };
  const weights = { shots: 0.35, shotsOnTarget: 0.30, cards: 0.20, corners: 0.15 };
  return weighted(stats, weights);
}

function nhl(s) {
  const { home, away } = s;
  const stats = {
    shots:       norm(sum(home.shotsTotal, away.shotsTotal), 70),
    hits:        norm(sum(home.hits, away.hits), 60),
    powerPlays:  norm(sum(home.powerPlayOpportunities, away.powerPlayOpportunities), 8),
  };
  const weights = { shots: 0.45, hits: 0.30, powerPlays: 0.25 };
  return weighted(stats, weights);
}

function mlb(s) {
  const { home, away } = s;
  const stats = {
    hits:          norm(sum(home.batting_hits, away.batting_hits), 16),
    homeRuns:      norm(sum(home.batting_homeRuns, away.batting_homeRuns), 4),
    extraBaseHits: norm(sum(home.batting_extraBaseHits, away.batting_extraBaseHits), 8),
    stolenBases:   norm(sum(home.batting_stolenBases, away.batting_stolenBases), 4),
    errors:        norm(sum(home.fielding_errors, away.fielding_errors), 3),
  };
  const weights = { hits: 0.25, homeRuns: 0.25, extraBaseHits: 0.20, stolenBases: 0.15, errors: 0.15 };
  return weighted(stats, weights);
}

function nba(s) {
  const { home, away } = s;
  const THREE_KEY = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';
  const stats = {
    threePointers: norm(sum(home[THREE_KEY], away[THREE_KEY]), 28),
    stealsBlocks:  norm(sum(home.steals, away.steals) + sum(home.blocks, away.blocks), 18),
  };
  const weights = { threePointers: 0.50, stealsBlocks: 0.50 };
  return weighted(stats, weights);
}

function nfl(s) {
  const { home, away } = s;
  const stats = {
    turnovers:  norm(sum(home.interceptions, away.interceptions) + sum(home.fumbles, away.fumbles), 4),
    firstDowns: norm(sum(home.firstDowns, away.firstDowns), 50),
    yards:      norm(sum(home.totalYards, away.totalYards), 800),
  };
  const weights = { turnovers: 0.40, firstDowns: 0.30, yards: 0.30 };
  return weighted(stats, weights);
}

function weighted(stats, weights) {
  const score = Math.round(
    Object.entries(weights).reduce((acc, [k, w]) => acc + (stats[k] || 0) * w, 0) * MAX_BONUS
  );
  return { score, breakdown: stats };
}

const BY_SPORT = {
  epl: soccer, mls: soccer, ucl: soccer,
  nhl,
  mlb,
  nba, cbb: nba,
  nfl, cfb: nfl,
};

// Compute activity bonus from a stats snapshot and store to Redis.
// Overwrites on every stats cycle so live games get updated values as the game progresses.
// Done games are stable — overwriting with the same data is harmless.
export async function recordStatsBonus(game, statsSnapshot) {
  const compute = BY_SPORT[game.sport];
  if (!compute) return null;

  const result = compute(statsSnapshot);
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
