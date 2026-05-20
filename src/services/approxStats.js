import { setCache, getCache } from './cache.js';

const APPROX_TTL = 30 * 24 * 60 * 60; // 30 days

// Pick uniformly from the unique set of values reachable by adding offsets in
// [-noise, +noise] to value, clamped to >= 0.  Deduplication prevents low values
// (e.g. 0) from being overrepresented just because multiple offsets clamp to the
// same floor.
function fuzz(value, noise) {
  const v = Math.round(value);
  const candidates = new Set();
  for (let i = -noise; i <= noise; i++) candidates.add(Math.max(0, v + i));
  const pool = [...candidates];
  return pool[Math.floor(Math.random() * pool.length)];
}

function sum(a, b) {
  return (a || 0) + (b || 0);
}

function soccer(game, s) {
  const { home, away } = s;
  return {
    goals:         fuzz(sum(game.home?.score, game.away?.score), 2),
    shots:         fuzz(sum(home.totalShots, away.totalShots), 4),
    shotsOnTarget: fuzz(sum(home.shotsOnTarget, away.shotsOnTarget), 2),
    saves:         fuzz(sum(home.saves, away.saves), 2),
    cards:         fuzz(sum(home.yellowCards, away.yellowCards) + sum(home.redCards, away.redCards), 2),
    fouls:         fuzz(sum(home.foulsCommitted, away.foulsCommitted), 4),
    corners:       fuzz(sum(home.wonCorners, away.wonCorners), 2),
    tackles:       fuzz(sum(home.totalTackles, away.totalTackles), 4),
    interceptions: fuzz(sum(home.interceptions, away.interceptions), 2),
    possession:    { home: home.possessionPct ?? null, away: away.possessionPct ?? null },
  };
}

function nhl(game, s) {
  const { home, away } = s;
  const hG = home.goalies?.[0] || {};
  const aG = away.goalies?.[0] || {};
  return {
    goals:          fuzz(sum(game.home?.score, game.away?.score), 2),
    shots:          fuzz(sum(home.shotsTotal, away.shotsTotal), 8),
    saves:          fuzz(sum(hG.saves, aG.saves), 8),
    powerPlayGoals: fuzz(sum(home.powerPlayGoals, away.powerPlayGoals), 2),
    hits:           fuzz(sum(home.hits, away.hits), 5),
    blockedShots:   fuzz(sum(home.blockedShots, away.blockedShots), 5),
    giveaways:      fuzz(sum(home.giveaways, away.giveaways), 2),
    takeaways:      fuzz(sum(home.takeaways, away.takeaways), 2),
  };
}

function mlb(game, s) {
  const { home, away } = s;
  return {
    runs:          fuzz(sum(game.home?.score, game.away?.score), 2),
    hits:          fuzz(sum(home.batting_hits, away.batting_hits), 3),
    errors:        fuzz(sum(home.fielding_errors, away.fielding_errors), 1),
    extraBaseHits: fuzz(sum(home.batting_extraBaseHits, away.batting_extraBaseHits), 1),
    homeRuns:      fuzz(sum(home.batting_homeRuns, away.batting_homeRuns), 1),
    walks:         fuzz(sum(home.batting_walks, away.batting_walks), 2),
    stolenBases:   fuzz(sum(home.batting_stolenBases, away.batting_stolenBases), 1),
    doublePlays:   fuzz(sum(home.fielding_doublePlays, away.fielding_doublePlays), 1),
    strikeouts:    fuzz(sum(home.batting_strikeouts, away.batting_strikeouts), 3),
  };
}

function nba(game, s) {
  const { home, away } = s;
  const THREE_KEY = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';
  return {
    points:        fuzz(sum(game.home?.score, game.away?.score), 15),
    threePointers: fuzz(sum(home[THREE_KEY], away[THREE_KEY]), 3),
    rebounds:      fuzz(sum(home.totalRebounds, away.totalRebounds), 8),
    stealsBlocks:  fuzz(sum(home.steals, away.steals) + sum(home.blocks, away.blocks), 3),
    turnovers:     fuzz(sum(home.totalTurnovers, away.totalTurnovers), 3),
  };
}

function nfl(game, s) {
  const { home, away } = s;
  return {
    points:        fuzz(sum(game.home?.score, game.away?.score), 7),
    interceptions: fuzz(sum(home.interceptions, away.interceptions), 1),
    firstDowns:    fuzz(sum(home.firstDowns, away.firstDowns), 5),
    fumbles:       fuzz(sum(home.fumbles, away.fumbles), 1),
  };
}

const BY_SPORT = {
  epl: soccer, mls: soccer, ucl: soccer,
  nhl,
  mlb,
  nba, cbb: nba,
  nfl, cfb: nfl,
};

// Compute fuzzed stats for a completed game and persist to Redis.
// No-ops if a record already exists — fuzz runs once so every user sees the same numbers.
export async function recordApproxStats(game, statsSnapshot) {
  const existing = await getCache(`approx-stats:${game.id}`);
  if (existing) return existing;

  const compute = BY_SPORT[game.sport];
  if (!compute) return null;

  const approx = compute(game, statsSnapshot);
  const record = { t: Date.now(), sport: game.sport, approx };
  await setCache(`approx-stats:${game.id}`, record, APPROX_TTL);
  return record;
}

export async function getApproxStats(gameId) {
  return await getCache(`approx-stats:${gameId}`) || null;
}
