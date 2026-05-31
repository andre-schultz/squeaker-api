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

import { fetchAllEvents, preFreezeGames, pruneFrozenGame } from './espn.js';
import { fetchSGOLiveEvents, recordOddsSnapshot, computeBettingScore } from './sgo.js';
import { recordStatsSnapshot } from './stats.js';
import { recordApproxStats } from './approxStats.js';
import { recordStatsBonus } from './statsBonus.js';
import { setCache, getCache, drainCacheCounters } from './cache.js';
import {
  CACHE_TTL,
  AUDIT_ENABLED,
  SGO_ENABLED,
  SPORTS,
  HOURS_WINDOW,
} from '../config.js';

// Format a drained-counters snapshot as a compact log string.
// e.g. "GET.frozenGame=120 GET.games=2 SET.games=2 SET.probabilities=5"
function fmtCounters(counts) {
  const entries = Object.entries(counts).sort();
  if (entries.length === 0) return '(none)';
  const total = entries.reduce((s, [, v]) => s + v, 0);
  return `${total} ops — ` + entries.map(([k, v]) => `${k}=${v}`).join(' ');
}

const GAME_REFRESH_MS = 3 * 60 * 1000;     // 3 min, active hours
const ODDS_REFRESH_MS = 10 * 60 * 1000;    // 10 min — matches SGO update frequency
const STATS_REFRESH_MS = 3 * 60 * 1000;    // 3 min — same cadence as game cycle
const OFF_REFRESH_MS = 10 * 60 * 1000;     // 10 min, off hours
const TICK_MS = 60 * 1000;                  // wake up once a minute
const HISTORY_TTL = CACHE_TTL.history;

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

// ── Game lifecycle tracking ───────────────────────────────────────────────────
// _doneGames holds every game that has finished, keyed by game ID. It is the
// authoritative in-memory store for done games — nothing reads Redis or calls
// ESPN for these games again. It is initialized from games:all on first run so
// a process restart recovers immediately from the single existing Redis key.
//
// _initialized gates the one-time boot load so subsequent cycles skip it.
const _doneGames   = new Map(); // gameId → done game object (includes doneAt)
let   _initialized = false;

// ── Game cycle (refresh games:all) ────────────────────────────────────────────

let gameRunning = false;

async function runGameCycle() {
  if (gameRunning) return;
  gameRunning = true;
  try {
    const now = new Date().toISOString();

    // ── One-time boot: recover done games from the previous Redis snapshot ──
    // This is the ONLY time we read games:all from Redis for population
    // purposes. After this, done games live purely in _doneGames.
    if (!_initialized) {
      const prev = (await getCache('games:all')) || [];
      for (const g of prev) {
        if (g.done) _doneGames.set(g.id, g);
      }
      // Pre-populate espn.js frozenGames so the first ESPN cycle skips full
      // processing for done games that are already in _doneGames.
      preFreezeGames([..._doneGames.values()]);
      console.log(`[games] boot: recovered ${_doneGames.size} done games from cache`);
      _initialized = true;
    }

    // ── Fetch live + newly-done games from ESPN (today ± 1 day only) ──────
    // espn.js now only fetches 3 date strings, so ESPN is never called for
    // games older than yesterday. Done games from prior days come from _doneGames.
    const { games: freshGames, upcoming } = await fetchAllEvents();

    // ── Update _doneGames with any newly-finished games ───────────────────
    for (const game of freshGames) {
      if (game.done && !_doneGames.has(game.id)) {
        // First time we see this game as done — stamp doneAt and remember it.
        _doneGames.set(game.id, { ...game, doneAt: now });
      }
    }

    // ── Prune done games older than the display window (5 days) ──────────
    // Both _doneGames (warmup.js) and frozenGames (espn.js) are kept in sync
    // so neither Map accumulates stale entries across long-running processes.
    const cutoff = Date.now() - HOURS_WINDOW * 60 * 60 * 1000;
    for (const [id, g] of _doneGames) {
      // Fall back to doneAt when game.date is missing/malformed so a bad date
      // can't pin a stale entry in the map forever (NaN < cutoff is false).
      const dateTs = new Date(g.date).getTime();
      const ts = Number.isNaN(dateTs) ? new Date(g.doneAt ?? 0).getTime() : dateTs;
      if (!Number.isFinite(ts) || ts < cutoff) {
        _doneGames.delete(id);
        pruneFrozenGame(id);
      }
    }

    // ── Compose full game list: live (fresh) + all known done games ───────
    const liveGames = freshGames.filter(g => g.live);
    const allGames  = [...liveGames, ..._doneGames.values()]
      .sort((a, b) => b.excitement - a.excitement);

    const ttl = liveGames.length > 0 ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
    await setCache('games:all', allGames, ttl);
    await setCache('games:upcoming', upcoming, CACHE_TTL.finishedGames);

    console.log(`[games] refreshed — ${liveGames.length} live, ${_doneGames.size} done, ${upcoming.length} upcoming`);
    console.log(`[redis] game-cycle — ${fmtCounters(drainCacheCounters())}`);
  } catch (e) {
    console.error('[games] cycle failed:', e.message);
    drainCacheCounters();
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
// finished (done within the last hour — see isActiveCandidate). Stores:
//   stats:{gameId}          — latest snapshot (team stats + sport-specific details)
//   stats-timeline:{gameId} — append-only, one entry per scoring change

let statsRunning = false;

// Run an async fn over items with bounded concurrency so a big slate doesn't
// fire dozens of ESPN /summary calls at once. Preserves the per-item awaits'
// independence (each game writes its own Redis keys).
async function forEachLimited(items, limit, fn) {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

async function runStatsCycle() {
  if (statsRunning) return;
  statsRunning = true;
  const t0 = Date.now();
  try {
    const games = (await getCache('games:all')) || [];

    const candidates = games.filter(isActiveCandidate);

    if (candidates.length === 0) return;

    let fetched = 0;
    await forEachLimited(candidates, 4, async (game) => {
      const cfg = SPORTS[game.sport];
      if (!cfg) return;
      const snapshot = await recordStatsSnapshot(game, cfg.espnSport, cfg.espnLeague);
      if (!snapshot) return;
      fetched++;
      await recordStatsBonus(game, snapshot);
      if (game.done) {
        await saveHistory(game, { stats: snapshot });
        await recordApproxStats(game, snapshot);
      }
    });

    console.log(`[stats] cycle: ${candidates.length} games, ${fetched} fetched (${Date.now() - t0}ms)`);
    console.log(`[redis] stats-cycle — ${fmtCounters(drainCacheCounters())}`);
  } catch (e) {
    console.error('[stats] cycle failed:', e.message);
    drainCacheCounters();
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
    console.log(`[redis] odds-cycle — ${fmtCounters(drainCacheCounters())}`);
  } catch (e) {
    console.error('[odds] cycle failed:', e.message);
    drainCacheCounters();
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

// True while a game is worth fetching stats for: started but not yet stale.
// Scheduled games are excluded — ESPN returns no boxscore until kickoff.
// Done games are dropped after 1 hour to stop hammering finished games.
function isActiveCandidate(game) {
  if (!game.live && !game.done) return false;
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
