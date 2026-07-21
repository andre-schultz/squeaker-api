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

import { fetchAllEvents, preFreezeGames, pruneFrozenGame, seedPregameMeta } from './espn.js';
import { recordStatsSnapshot } from './stats.js';
import { recordApproxStats } from './approxStats.js';
import { recordStatsBonus } from './statsBonus.js';
import { pruneOdds } from './odds.js';
import { pruneWPTracking } from './probabilities.js';
import { pruneAuditTracking } from './audit.js';
import { setCache, getCache, drainCacheCounters } from './cache.js';
import {
  CACHE_TTL,
  AUDIT_ENABLED,
  SPORTS,
  HOURS_WINDOW,
  etDayKey,
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
// ESPN for these games again. It is initialized from the day shards on first
// run so a process restart recovers the full window immediately.
//
// _initialized gates the one-time boot load so subsequent cycles skip it.
const _doneGames   = new Map(); // gameId → done game object (includes doneAt)
let   _initialized = false;

// ── Per-day shards ────────────────────────────────────────────────────────────
// games:all used to be a single blob covering the whole window — ~1.7 MB in winter,
// rewritten every 3 minutes even though all but the newest day is immutable.
// Games are now also written as games:day:{YYYY-MM-DD} shards so the app can
// load one day at a time, and a shard is only rewritten when its contents
// actually change (in practice: today, plus a day that gains a late finisher).
//
// _shardSigs holds the last-written signature per day so we can skip no-op
// writes. It starts empty after a restart, so the first cycle rewrites every
// shard — which also refreshes their TTLs, making the restart self-healing.
const _shardSigs = new Map(); // 'YYYY-MM-DD' → signature string

// The composed live+done list from the most recent game cycle. The stats cycle
// used to re-read this from games:all; now that the game cycle no longer writes
// that key, it hands the list over in memory instead — same data, one less
// Redis round-trip, and no dependency on a key that exists only for old clients.
let _lastAllGames = [];

// A day's shard is identified by which games it holds and what state they're
// in. Live games change excitement every cycle, so their score is part of the
// signature; done games are frozen, so id+doneAt is enough to spot an addition.
function shardSignature(games) {
  return games
    .map(g => `${g.id}:${g.live ? `L${g.excitement}` : `D${g.doneAt ?? ''}`}`)
    .sort()
    .join('|');
}

function groupByDay(games) {
  const byDay = new Map();
  for (const g of games) {
    const key = etDayKey(g.date);
    if (!key) continue; // malformed date — cannot be filed under a day
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(g);
  }
  return byDay;
}

// ── Game cycle (refresh the day shards + index) ───────────────────────────────

let gameRunning = false;

async function runGameCycle() {
  if (gameRunning) return;
  gameRunning = true;
  try {
    const now = new Date().toISOString();

    // ── One-time boot: recover done games from the previous Redis snapshot ──
    // This is the ONLY time we read game lists from Redis for population
    // purposes. After this, done games live purely in _doneGames.
    if (!_initialized) {
      // The day shards are the snapshot. An empty index means a genuinely cold
      // cache: the window rebuilds from ESPN over the following days rather
      // than being restored. (Seeding an existing deployment's history into
      // shards is a one-off — see scripts/migrate-day-shards.mjs.)
      const index = (await getCache('games:index')) || [];
      const shards = await Promise.all(
        index.map(d => getCache(`games:day:${d.date}`).then(s => s || []))
      );
      for (const g of shards.flat()) {
        if (g.done) _doneGames.set(g.id, g);
      }
      // Pre-populate espn.js frozenGames so the first ESPN cycle skips full
      // processing for done games that are already in _doneGames.
      preFreezeGames([..._doneGames.values()]);
      // Recover pre-game record/rank for games that were still scheduled or in
      // progress when the process went down, so they can be frozen correctly
      // when they finish rather than falling back to null.
      seedPregameMeta((await getCache('games:upcoming')) || []);
      console.log(`[games] boot: recovered ${_doneGames.size} done games from ${index.length} day shards`);
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

    // ── Prune done games older than the display window (12 days) ─────────
    // Every per-game in-process store is pruned together — _doneGames here,
    // plus espn.js frozenGames, odds.js _memOdds, probabilities.js
    // doneSnapshotted, and audit.js doneAudited — so none of them accumulate
    // stale entries across long-running processes.
    const cutoff = Date.now() - HOURS_WINDOW * 60 * 60 * 1000;
    for (const [id, g] of _doneGames) {
      // Fall back to doneAt when game.date is missing/malformed so a bad date
      // can't pin a stale entry in the map forever (NaN < cutoff is false).
      const dateTs = new Date(g.date).getTime();
      const ts = Number.isNaN(dateTs) ? new Date(g.doneAt ?? 0).getTime() : dateTs;
      if (!Number.isFinite(ts) || ts < cutoff) {
        _doneGames.delete(id);
        pruneFrozenGame(id);
        pruneOdds(id);
        pruneWPTracking(id);
        pruneAuditTracking(id);
      }
    }

    // ── Compose full game list: live (fresh) + all known done games ───────
    const liveGames = freshGames.filter(g => g.live);
    const allGames  = [...liveGames, ..._doneGames.values()]
      .sort((a, b) => b.excitement - a.excitement);
    _lastAllGames = allGames;

    // ── Per-day shards + index ────────────────────────────────────────────
    // Shards are written before the index so a client that reads the index the
    // moment it appears always finds every shard it points at.
    const byDay = groupByDay(allGames);
    const days  = [...byDay.keys()].sort((a, b) => b.localeCompare(a)); // newest first

    let written = 0;
    for (const date of days) {
      const dayGames = byDay.get(date).sort((a, b) => b.excitement - a.excitement);
      const sig = shardSignature(dayGames);
      if (_shardSigs.get(date) === sig) continue; // unchanged since last write
      await setCache(`games:day:${date}`, dayGames, CACHE_TTL.dayShard);
      _shardSigs.set(date, sig);
      written++;
    }
    // Drop signatures for days that have aged out so the Map can't grow forever.
    for (const date of _shardSigs.keys()) {
      if (!byDay.has(date)) _shardSigs.delete(date);
    }

    // The index drives the date chips, so it has to be fetchable on its own,
    // before any shard is loaded — one small row per day.
    const index = days.map(date => {
      const dayGames = byDay.get(date);
      return {
        date,
        count: dayGames.length,
        live:  dayGames.filter(g => g.live).length,
      };
    });
    await setCache('games:index', index, CACHE_TTL.gamesIndex);

    // games:all is intentionally not written any more. The legacy flat list is
    // composed from these shards on request (see routes/games.js), so there is
    // no second copy of the window to keep in sync or pay for on every cycle.
    await setCache('games:upcoming', upcoming, CACHE_TTL.finishedGames);

    console.log(`[games] refreshed — ${liveGames.length} live, ${_doneGames.size} done, ${upcoming.length} upcoming`);
    console.log(`[games] shards — ${days.length} days, ${written} rewritten`);
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

  // Already saved with final stats — the row can't get any more complete, so
  // skip the rewrite (this runs every stats cycle for an hour after each game).
  if (existing?.finalStats) return;

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
    comebackBonus: game.comebackBonus ?? 0,
    comebackSignals: game.comebackSignals ?? [],
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
    // Handed over by the game cycle rather than re-read from Redis. Empty only
    // before the first game cycle completes, in which case this round no-ops
    // and the next one picks the games up.
    const candidates = _lastAllGames.filter(isActiveCandidate);

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
let lastStatsRun = 0;

function tick() {
  const gameInterval  = isOffHours() ? OFF_REFRESH_MS : GAME_REFRESH_MS;
  const statsInterval = isOffHours() ? OFF_REFRESH_MS : STATS_REFRESH_MS;
  const now = Date.now();

  if (now - lastGameRun >= gameInterval) {
    lastGameRun = now;
    runGameCycle();
  }
  if (now - lastStatsRun >= statsInterval) {
    lastStatsRun = now;
    runStatsCycle();
  }
}

async function warmCache() {
  console.log(
    `[warmup] initial warm… ` +
    `AUDIT_ENABLED=${AUDIT_ENABLED} (raw=${JSON.stringify(process.env.AUDIT_ENABLED)})`
  );
  await runGameCycle();
  await runStatsCycle();
  console.log('[warmup] initial warm complete');
}

export function startWarmupSchedule() {
  // Initial warm — fire and forget; tick() will continue the cadence.
  warmCache();
  // Single steady cadence; the tick gates work by elapsed time.
  setInterval(tick, TICK_MS);
}
