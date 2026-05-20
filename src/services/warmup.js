// Background scheduling for game + buzz refresh.
//
// Memory-leak fixes vs previous model:
//  • Single setInterval ticking every minute, work gated by elapsed time.
//    No recursive setTimeout closures — each tick is a fresh stack frame.
//  • Concurrency guards prevent overlapping cycles (two buzz cycles running
//    at once would double allocations).
//  • Buzz cycle reuses cached games rather than re-fetching ESPN.
//  • All HTTP responses are drained inside espn.js even on
//    error paths so undici sockets get released promptly.

import { fetchAllGames } from './espn.js';
import { fetchSGOLiveEvents, recordOddsSnapshot, computeBettingScore } from './sgo.js';
import { recordStatsSnapshot } from './stats.js';
import { recordApproxStats } from './approxStats.js';
import { recordStatsBonus } from './statsBonus.js';
import { setCache, getCache } from './cache.js';
import {
  CACHE_TTL,
  AUDIT_ENABLED,
  SGO_ENABLED,
  SPORTS,
} from '../config.js';

const GAME_REFRESH_MS = 3 * 60 * 1000;     // 3 min, active hours
const ODDS_REFRESH_MS = 10 * 60 * 1000;    // 10 min — matches SGO update frequency
const STATS_REFRESH_MS = 3 * 60 * 1000;    // 3 min — same cadence as game cycle
const OFF_REFRESH_MS = 10 * 60 * 1000;     // 10 min, off hours
const TICK_MS = 60 * 1000;                  // wake up once a minute
const HISTORY_TTL = 7 * 24 * 60 * 60;

// ── Off-hours throttle ────────────────────────────────────────────────────────

function isOffHours() {
  const etHour = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });
  const hour = parseInt(etHour);
  return hour >= 2 && hour < 9;
}

// ── Game cycle (refresh games:all) ────────────────────────────────────────────

let gameRunning = false;

async function runGameCycle() {
  if (gameRunning) return;
  gameRunning = true;
  try {
    const prev = (await getCache('games:all')) || [];
    const prevDoneAt = Object.fromEntries(
      prev.filter(g => g.doneAt).map(g => [g.id, g.doneAt])
    );
    const now = new Date().toISOString();
    const games = await fetchAllGames();
    const enriched = games.map(g => ({
      ...g,
      doneAt: g.done ? (prevDoneAt[g.id] ?? now) : undefined,
    }));
    const hasLive = enriched.some((g) => g.live);
    const ttl = hasLive ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
    await setCache('games:all', enriched, ttl);
    console.log(`[games] refreshed (${enriched.length} games)`);
  } catch (e) {
    console.error('[games] cycle failed:', e.message);
  } finally {
    gameRunning = false;
  }
}

// Per-finished-game snapshot for review/leaderboards.
async function saveHistory(game, { stats } = {}) {
  if (!game.done) return;
  const date = new Date(game.date).toISOString().slice(0, 10);
  const key = `history:${date}:${game.id}`;
  const existing = await getCache(key);

  const base = existing || {
    id: game.id,
    date: game.date,
    sport: game.sport,
    sportName: game.sportName,
    homeTeam: game.home.name,
    awayTeam: game.away.name,
    homeScore: game.home.score,
    awayScore: game.away.score,
    margin: game.margin,
    isOT: game.isOT,
    isComeback: game.isComeback,
    excitementScore: game.excitement,
    excitementDesc: game.desc,
    momentumBonus: game.momentumBonus ?? 0,
    momentumSignals: game.momentumSignals ?? [],
  };

  // Final team stats snapshot — only written once (when the game is done) and
  // only updated if we have fresh data. Goalies array preserves per-goalie lines.
  const statsFields = stats ? {
    finalStats: {
      home: stats.home,
      away: stats.away,
      recordedAt: new Date().toISOString(),
    },
  } : {};

  const row = {
    ...base,
    ...statsFields,
    savedAt: new Date().toISOString(),
  };

  await setCache(key, row, HISTORY_TTL);
  if (!existing) {
    console.log(`[history] saved ${game.away.abbr} vs ${game.home.abbr} (${date})`);
  }
}

// ── Stats cycle (fetch ESPN summary stats for all tracked sports) ─────────────
//
// Polls the ESPN /summary endpoint for every game that is live or recently
// finished (within 36 hours). Stores:
//   stats:{gameId}          — latest snapshot (team stats + sport-specific details)
//   stats-timeline:{gameId} — append-only, one entry per scoring change

let statsRunning = false;

async function runStatsCycle() {
  if (statsRunning) return;
  statsRunning = true;
  const t0 = Date.now();
  try {
    const games = (await getCache('games:all')) || [];

    const candidates = games.filter(isActiveCandidate);

    if (candidates.length === 0) return;

    let fetched = 0;
    for (const game of candidates) {
      const cfg = SPORTS[game.sport];
      if (!cfg) continue;
      const snapshot = await recordStatsSnapshot(game, cfg.espnSport, cfg.espnLeague);
      if (snapshot) {
        fetched++;
        await recordStatsBonus(game, snapshot);
        if (game.done) {
          await saveHistory(game, { stats: snapshot });
          await recordApproxStats(game, snapshot);
        }
      }
    }

    console.log(`[stats] cycle: ${candidates.length} games, ${fetched} fetched (${Date.now() - t0}ms)`);
  } catch (e) {
    console.error('[stats] cycle failed:', e.message);
  } finally {
    statsRunning = false;
  }
}

// ── Odds cycle (poll SGO live lines, record WP timeline, update betting score) ─
//
// Only fires when SGO_ENABLED (SGO_API_KEY is set) AND at least one game is
// currently live — this keeps object usage minimal on the free tier.
// One SGO call fetches all live events in a single request (1 object per game
// returned). Per-game matching is done client-side against games:all.

let oddsRunning = false;

async function runOddsCycle() {
  if (oddsRunning) return;
  oddsRunning = true;
  const t0 = Date.now();
  try {
    const games    = (await getCache('games:all')) || [];
    const liveGames = games.filter(g => g.live);
    if (liveGames.length === 0) return; // no live games — don't burn objects

    const sgoEvents = await fetchSGOLiveEvents(liveGames);
    if (sgoEvents.length === 0) {
      console.log('[odds] SGO returned no live events');
      return;
    }

    let matched = 0;
    let newPeaks = 0;
    for (const game of liveGames) {
      const timeline = await recordOddsSnapshot(game, sgoEvents);
      if (!timeline) continue;
      matched++;

      const breakdown = computeBettingScore(timeline);
      // Only update peak once we have at least 2 real SGO reads — a single
      // read has nothing to compare against and would lock in a zero peak.
      const sgoCount = timeline.filter(s => !s.isBaseline).length;
      const { replaced } = sgoCount >= 2
        ? await updatePeakBetting(game, breakdown)
        : { replaced: false };
      if (replaced) newPeaks++;
    }

    console.log(
      `[odds] cycle: ${liveGames.length} live, ${matched} matched, ` +
      `${newPeaks} new peaks, ${sgoEvents.length} SGO events (${Date.now() - t0}ms)`
    );
  } catch (e) {
    console.error('[odds] cycle failed:', e.message);
  } finally {
    oddsRunning = false;
  }
}

// Keep the highest betting score seen during the game's live period.
async function updatePeakBetting(game, breakdown) {
  const key  = `betting:${game.id}`;
  const prev = await getCache(key);

  const current = {
    current:       breakdown.score,
    drift:         breakdown.drift,
    velocity:      breakdown.velocity,
    openingHomeWP: breakdown.openingHomeWP,
    currentHomeWP: breakdown.currentHomeWP,
    windowSamples: breakdown.windowSamples,
    peak:          Math.max(breakdown.score, prev?.peak ?? 0),
    recordedAt:    new Date().toISOString(),
    wasLive:       true,
  };

  const replaced = breakdown.score > (prev?.peak ?? -1);
  await setCache(key, current, CACHE_TTL.bettingPeak);
  return { replaced };
}

// ── Candidate filters ─────────────────────────────────────────────────────────

// True while a game is still worth processing: live/upcoming, or done but
// finished within the last hour. Uses doneAt stamped by runGameCycle.
function isActiveCandidate(game) {
  if (!game.done) return true;
  if (!game.doneAt) return true;
  return (Date.now() - new Date(game.doneAt).getTime()) < 60 * 60 * 1000;
}

// ── Tick loop ─────────────────────────────────────────────────────────────────

let lastGameRun = 0;
let lastOddsRun = 0;
let lastStatsRun = 0;

function tick() {
  const gameInterval  = isOffHours() ? OFF_REFRESH_MS : GAME_REFRESH_MS;
  const statsInterval = isOffHours() ? OFF_REFRESH_MS : STATS_REFRESH_MS;
  const now = Date.now();

  if (now - lastGameRun >= gameInterval) {
    lastGameRun = now;
    runGameCycle();
  }
  if (SGO_ENABLED && now - lastOddsRun >= ODDS_REFRESH_MS) {
    lastOddsRun = now;
    runOddsCycle();
  }
  if (now - lastStatsRun >= statsInterval) {
    lastStatsRun = now;
    runStatsCycle();
  }
}

export async function warmCache() {
  console.log(
    `[warmup] initial warm… ` +
    `AUDIT_ENABLED=${AUDIT_ENABLED} (raw=${JSON.stringify(process.env.AUDIT_ENABLED)})`
  );
  await runGameCycle();
  if (SGO_ENABLED) {
    await runOddsCycle();
  } else {
    console.log('[odds] disabled (SGO_API_KEY not set) — skipping');
  }
  await runStatsCycle();
  console.log('[warmup] initial warm complete');
}

export function startWarmupSchedule() {
  // Initial warm — fire and forget; tick() will continue the cadence.
  warmCache();
  // Single steady cadence; the tick gates work by elapsed time.
  setInterval(tick, TICK_MS);
}
