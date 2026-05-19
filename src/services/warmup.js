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
import { chatterForGame } from './bluesky.js';
import { authConfigured } from './bsky-auth.js';
import { fetchSGOLiveEvents, recordOddsSnapshot, computeBettingScore } from './sgo.js';
import { recordStatsSnapshot } from './stats.js';
import { recordApproxStats } from './approxStats.js';
import { setCache, getCache } from './cache.js';
import {
  CACHE_TTL,
  AUDIT_ENABLED,
  BLUESKY_ENABLED,
  BLUESKY_HANDLE,
  BLUESKY_QUERY_DELAY_MS,
  SGO_ENABLED,
  SPORTS,
} from '../config.js';

const GAME_REFRESH_MS = 3 * 60 * 1000;     // 3 min, active hours
const CHATTER_REFRESH_MS = 5 * 60 * 1000;  // 5 min, active hours
const ODDS_REFRESH_MS = 10 * 60 * 1000;    // 10 min — matches SGO update frequency
const STATS_REFRESH_MS = 3 * 60 * 1000;    // 3 min — same cadence as game cycle
const OFF_REFRESH_MS = 10 * 60 * 1000;     // 10 min, off hours
const TICK_MS = 60 * 1000;                  // wake up once a minute
const HISTORY_TTL = 30 * 24 * 60 * 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ── Chatter cycle (per-game Bluesky search → sticky peak chatter) ─────────────
//
// Unlike the buzz cycle, this does N HTTP requests per cycle (one per
// candidate game), spaced by BLUESKY_QUERY_DELAY_MS to stay under the public
// AppView's ~3000 req/5min/IP budget. Uses sort=top so only engaged posts
// (likes+reposts+replies >= 3) contribute to the score.

let chatterRunning = false;

async function runChatterCycle() {
  if (chatterRunning) return;
  chatterRunning = true;
  const t0 = Date.now();
  try {
    const games = (await getCache('games:all')) || [];
    if (games.length === 0) {
      console.log('[chatter] games:all empty, skipping cycle');
      return;
    }

    const candidates = games.filter(isActiveCandidate);

    let matched = 0;
    let newPeaks = 0;
    for (const game of candidates) {
      // 5% chance to snapshot raw posts for a live game, at most once per game.
      const takeSample = game.live
        && Math.random() < 0.05
        && !(await getCache(`chatter-sample:${game.id}`));

      const current = await chatterForGame(game, { includeSample: takeSample });
      if (current) matched++;

      if (takeSample && current?.sample) {
        const samplePosts = current.sample;
        delete current.sample;
        await setCache(`chatter-sample:${game.id}`, {
          gameLabel: `${game.away.name} vs ${game.home.name}`,
          sampledAt: new Date().toISOString(),
          posts: samplePosts,
        }, 30 * 24 * 3600);
        console.log(`[chatter] saved post sample for game ${game.id}`);
      }

      const { peak, replaced } = await updatePeakChatter(game, current);
      if (replaced) newPeaks++;
      await saveHistory(game, { peakChatter: peak });
      await sleep(BLUESKY_QUERY_DELAY_MS);
    }

    console.log(
      `[chatter] cycle: ${candidates.length} games, ${matched} matched, ${newPeaks} new peaks (${Date.now() - t0}ms)`
    );
  } catch (e) {
    console.error('[chatter] cycle failed:', e.message);
  } finally {
    chatterRunning = false;
  }
}

async function updatePeakChatter(game, current) {
  const key = `chatter:${game.id}`;
  const prev = await getCache(key);

  if (!current) {
    return { peak: prev || null, replaced: false };
  }

  if (current.chatter > (prev?.chatter ?? -1)) {
    const peak = {
      ...current,
      recordedAt: new Date().toISOString(),
      wasLive: game.live,
    };
    await setCache(key, peak, CACHE_TTL.chatterPeak);
    return { peak, replaced: true };
  }

  return { peak: prev, replaced: false };
}

// Per-finished-game snapshot for review/leaderboards. Called from BOTH the
// buzz cycle and the chatter cycle, each passing only its own peak — we
// merge into one row so whichever cycle runs first creates the base record
// and the other overlays its fields.
async function saveHistory(game, { peakChatter, stats } = {}) {
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

  const chatterFields = peakChatter ? {
    peakChatter:          peakChatter.chatter ?? null,
    peakEngagedCount:     peakChatter.engagedCount ?? null,
    peakAvgEngagement:    peakChatter.avgEngagement ?? null,
    peakTotalEngagement:  peakChatter.totalEngagement ?? null,
    chatterMatchedPosts:  peakChatter.matchedPosts ?? null,
  } : {};

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
    ...chatterFields,
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
let lastChatterRun = 0;
let lastOddsRun = 0;
let lastStatsRun = 0;

function tick() {
  const gameInterval    = isOffHours() ? OFF_REFRESH_MS : GAME_REFRESH_MS;
  const chatterInterval = isOffHours() ? OFF_REFRESH_MS : CHATTER_REFRESH_MS;
  const statsInterval   = isOffHours() ? OFF_REFRESH_MS : STATS_REFRESH_MS;
  const now = Date.now();

  if (now - lastGameRun >= gameInterval) {
    lastGameRun = now;
    runGameCycle();
  }
  if (BLUESKY_ENABLED && now - lastChatterRun >= chatterInterval) {
    lastChatterRun = now;
    runChatterCycle();
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
    `BLUESKY_ENABLED=${BLUESKY_ENABLED} (raw=${JSON.stringify(process.env.BLUESKY_ENABLED)}) ` +
    `BLUESKY_AUTH=${authConfigured() ? `configured(${BLUESKY_HANDLE})` : 'unset'} ` +
    `(handle_raw=${JSON.stringify(process.env.BLUESKY_HANDLE)} pw_set=${process.env.BLUESKY_APP_PASSWORD ? 'yes' : 'no'}) ` +
    `AUDIT_ENABLED=${AUDIT_ENABLED} (raw=${JSON.stringify(process.env.AUDIT_ENABLED)})`
  );
  await runGameCycle();
  if (BLUESKY_ENABLED) {
    await runChatterCycle();
  } else {
    console.log('[chatter] disabled (BLUESKY_ENABLED != true) — skipping');
  }
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
