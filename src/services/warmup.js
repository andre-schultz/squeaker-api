// Background scheduling for game, chatter, and article refresh.
//
// Memory-leak fixes vs previous model:
//  • Single setInterval ticking every minute, work gated by elapsed time.
//    No recursive setTimeout closures — each tick is a fresh stack frame.
//  • Concurrency guards prevent overlapping cycles.
//  • All HTTP responses are drained inside espn.js / bluesky.js even on
//    error paths so undici sockets get released promptly.

import { fetchAllGames } from './espn.js';
import { chatterForGame } from './bluesky.js';
import { authConfigured } from './bsky-auth.js';
import { fetchAllArticles, articlesForGame, updateGameArticles } from './articles.js';
import { setCache, getCache } from './cache.js';
import {
  CACHE_TTL,
  AUDIT_ENABLED,
  BLUESKY_ENABLED,
  BLUESKY_HANDLE,
  BLUESKY_QUERY_DELAY_MS,
} from '../config.js';

const GAME_REFRESH_MS = 3 * 60 * 1000;     // 3 min, active hours
const CHATTER_REFRESH_MS = 5 * 60 * 1000;  // 5 min, active hours
const ARTICLE_REFRESH_MS = 10 * 60 * 1000; // 10 min — articles update slowly
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

// ── Chatter cycle (per-game Bluesky search → sticky peak chatter) ─────────────
//
// Unlike the buzz cycle, this does N HTTP requests per cycle (one per
// candidate game), spaced by BLUESKY_QUERY_DELAY_MS to stay under the public
// AppView's ~3000 req/5min/IP budget. Each game gets three independent
// 0-100 scores: chatter, goodChatter, badChatter. Sticky peak per score
// triple — we keep the snapshot whose `chatter` is the highest seen so far.

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

    const candidates = games.filter((g) => {
      const ageHrs = (Date.now() - new Date(g.date).getTime()) / 3600000;
      return ageHrs <= 36;
    });

    let matched = 0;
    let newPeaks = 0;
    for (const game of candidates) {
      const current = await chatterForGame(game);
      if (current) matched++;
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

  // Sticky peak driven by total chatter — when a new high lands, the entire
  // snapshot (good/bad/raw counts) is replaced together so the three scores
  // stay internally consistent.
  const prevChatter = prev?.chatter ?? -1;
  if (current.chatter > prevChatter) {
    const peak = {
      ...current,
      recordedAt: new Date().toISOString(),
      wasLive: game.live,
    };
    await setCache(key, peak, CACHE_TTL.chatterPeak);
    return { peak, replaced: true };
  }

  await setCache(key, prev, CACHE_TTL.chatterPeak);
  return { peak: prev, replaced: false };
}

// Per-finished-game snapshot for review/leaderboards. Called from BOTH the
// buzz cycle and the chatter cycle, each passing only its own peak — we
// merge into one row so whichever cycle runs first creates the base record
// and the other overlays its fields. Buzz fields are namespaced under
// peakBuzz/peakGood/etc.; chatter fields under peakChatter/etc. so the two
// signals stay distinguishable in the audit data.
async function saveHistory(game, { peakChatter } = {}) {
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
    peakChatter:         peakChatter.chatter ?? null,
    peakGoodChatter:     peakChatter.goodChatter ?? null,
    peakBadChatter:      peakChatter.badChatter ?? null,
    chatterMatchedPosts: peakChatter.matchedPosts ?? null,
    chatterGoodPosts:    peakChatter.goodPosts ?? null,
    chatterBadPosts:     peakChatter.badPosts ?? null,
    chatterLikes:        peakChatter.likes ?? null,
    chatterReposts:      peakChatter.reposts ?? null,
    chatterReplies:      peakChatter.replies ?? null,
  } : {};

  const row = {
    ...base,
    ...chatterFields,
    savedAt: new Date().toISOString(),
  };

  await setCache(key, row, HISTORY_TTL);
  if (!existing) {
    console.log(`[history] saved ${game.away.abbr} vs ${game.home.abbr} (${date})`);
  }
}

// ── Article cycle (poll league news, match to games, store per-game) ──────────

let articleRunning = false;

async function runArticleCycle() {
  if (articleRunning) return;
  articleRunning = true;
  const t0 = Date.now();
  try {
    const games = (await getCache('games:all')) || [];
    if (games.length === 0) {
      console.log('[articles] games:all empty, skipping cycle');
      return;
    }
    const articles = await fetchAllArticles();
    console.log(`[articles] pool: ${articles.length} articles`);

    let matched = 0;
    for (const game of games) {
      const gameArticles = articlesForGame(game, articles);
      if (gameArticles.length > 0) matched++;
      await updateGameArticles(game, gameArticles);
    }
    console.log(
      `[articles] cycle: ${games.length} games, ${matched} matched (${Date.now() - t0}ms)`
    );
  } catch (e) {
    console.error('[articles] cycle failed:', e.message);
  } finally {
    articleRunning = false;
  }
}

// ── Tick loop ─────────────────────────────────────────────────────────────────

let lastGameRun = 0;
let lastChatterRun = 0;
let lastArticleRun = 0;

function tick() {
  const gameInterval    = isOffHours() ? OFF_REFRESH_MS : GAME_REFRESH_MS;
  const chatterInterval = isOffHours() ? OFF_REFRESH_MS : CHATTER_REFRESH_MS;
  const articleInterval = isOffHours() ? OFF_REFRESH_MS : ARTICLE_REFRESH_MS;
  const now = Date.now();

  if (now - lastGameRun >= gameInterval) {
    lastGameRun = now;
    runGameCycle();
  }
  if (BLUESKY_ENABLED && now - lastChatterRun >= chatterInterval) {
    lastChatterRun = now;
    runChatterCycle();
  }
  if (now - lastArticleRun >= articleInterval) {
    lastArticleRun = now;
    runArticleCycle();
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
  await runArticleCycle();
  console.log('[warmup] initial warm complete');
}

export function startWarmupSchedule() {
  // Initial warm — fire and forget; tick() will continue the cadence.
  warmCache();
  // Single steady cadence; the tick gates work by elapsed time.
  setInterval(tick, TICK_MS);
}
