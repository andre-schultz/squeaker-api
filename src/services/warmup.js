// Background scheduling for game + buzz refresh.
//
// Memory-leak fixes vs previous model:
//  • Single setInterval ticking every minute, work gated by elapsed time.
//    No recursive setTimeout closures — each tick is a fresh stack frame.
//  • Concurrency guards prevent overlapping cycles (two buzz cycles running
//    at once would double allocations).
//  • Buzz cycle reuses cached games rather than re-fetching ESPN.
//  • All HTTP responses are drained inside reddit.js / espn.js even on
//    error paths so undici sockets get released promptly.

import { fetchAllGames } from './espn.js';
import { fetchAllPosts, buzzForGame } from './reddit.js';
import { setCache, getCache } from './cache.js';
import { CACHE_TTL } from '../config.js';

const GAME_REFRESH_MS = 3 * 60 * 1000; // 3 min, active hours
const BUZZ_REFRESH_MS = 5 * 60 * 1000; // 5 min, active hours
const OFF_REFRESH_MS = 10 * 60 * 1000; // 10 min, off hours
const TICK_MS = 60 * 1000; // wake up once a minute, decide what to run
const HISTORY_TTL = 30 * 24 * 60 * 60;

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
    const games = await fetchAllGames();
    const hasLive = games.some((g) => g.live);
    const ttl = hasLive ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
    await setCache('games:all', games, ttl);
    console.log(`[games] refreshed (${games.length} games)`);
  } catch (e) {
    console.error('[games] cycle failed:', e.message);
  } finally {
    gameRunning = false;
  }
}

// ── Buzz cycle (poll subreddits, match to games, update peak buzz) ────────────

let buzzRunning = false;

async function runBuzzCycle() {
  if (buzzRunning) return;
  buzzRunning = true;
  const t0 = Date.now();
  try {
    const games = (await getCache('games:all')) || [];
    if (games.length === 0) {
      console.log('[buzz] games:all empty, skipping cycle');
      return;
    }

    const posts = await fetchAllPosts();
    console.log(`[buzz] pool: ${posts.length} posts across ${new Set(posts.map((p) => p.subreddit)).size} subs`);

    const candidates = games.filter((g) => {
      const ageHrs = (Date.now() - new Date(g.date).getTime()) / 3600000;
      return ageHrs <= 36;
    });

    let matched = 0;
    let newPeaks = 0;
    for (const game of candidates) {
      const current = buzzForGame(game, posts);
      if (current) matched++;
      const { peak, replaced } = await updatePeakBuzz(game, current);
      if (replaced) newPeaks++;
      await saveHistory(game, peak);
    }

    console.log(
      `[buzz] cycle: ${candidates.length} games, ${matched} matched, ${newPeaks} new peaks (${Date.now() - t0}ms)`
    );
  } catch (e) {
    console.error('[buzz] cycle failed:', e.message);
  } finally {
    buzzRunning = false;
  }
}

// Keep the highest buzz value we've ever observed for a game.
// Returns { peak: <stored value>, replaced: bool }.
async function updatePeakBuzz(game, current) {
  const key = `buzz:${game.id}`;
  const prev = await getCache(key);

  if (!current) {
    // Nothing fresh to record — return existing peak unchanged.
    return { peak: prev || null, replaced: false };
  }

  const prevBuzz = prev?.buzz ?? -1;
  if (current.buzz > prevBuzz) {
    const peak = {
      ...current,
      recordedAt: new Date().toISOString(),
      wasLive: game.live,
    };
    await setCache(key, peak, CACHE_TTL.buzzPeak);
    return { peak, replaced: true };
  }

  // Current is lower than peak — keep the peak, but extend its TTL so it
  // doesn't expire out from under an active game.
  await setCache(key, prev, CACHE_TTL.buzzPeak);
  return { peak: prev, replaced: false };
}

async function saveHistory(game, peak) {
  if (!game.done) return;
  const date = new Date(game.date).toISOString().slice(0, 10);
  const key = `history:${date}:${game.id}`;
  if (await getCache(key)) return;

  await setCache(
    key,
    {
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
      peakBuzz: peak?.buzz ?? null,
      peakGoodBuzz: peak?.goodBuzz ?? null,
      peakBadBuzz: peak?.badBuzz ?? null,
      peakSentiment: peak?.sentiment ?? null,
      peakComments: peak?.comments ?? null,
      peakVelocity: peak?.velocity ?? null,
      matchedPosts: peak?.matchedPosts ?? null,
      redditThread: peak?.threadUrl ?? null,
      savedAt: new Date().toISOString(),
    },
    HISTORY_TTL
  );
  console.log(`[history] saved ${game.away.abbr} vs ${game.home.abbr} (${date})`);
}

// ── Tick loop ─────────────────────────────────────────────────────────────────

let lastGameRun = 0;
let lastBuzzRun = 0;

function tick() {
  const gameInterval = isOffHours() ? OFF_REFRESH_MS : GAME_REFRESH_MS;
  const buzzInterval = isOffHours() ? OFF_REFRESH_MS : BUZZ_REFRESH_MS;
  const now = Date.now();

  if (now - lastGameRun >= gameInterval) {
    lastGameRun = now;
    runGameCycle();
  }
  if (now - lastBuzzRun >= buzzInterval) {
    lastBuzzRun = now;
    runBuzzCycle();
  }
}

export async function warmCache() {
  console.log('[warmup] initial warm…');
  await runGameCycle();
  await runBuzzCycle();
  console.log('[warmup] initial warm complete');
}

export function startWarmupSchedule() {
  // Initial warm — fire and forget; tick() will continue the cadence.
  warmCache();
  // Single steady cadence; the tick gates work by elapsed time.
  setInterval(tick, TICK_MS);
}
