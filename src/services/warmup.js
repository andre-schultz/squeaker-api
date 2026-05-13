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
import { chatterForGame } from './bluesky.js';
import { authConfigured } from './bsky-auth.js';
import { fetchAllArticles, articlesForGame, updateGameArticles } from './articles.js';
import { setCache, getCache } from './cache.js';
import {
  CACHE_TTL,
  REDDIT_ENABLED,
  AUDIT_ENABLED,
  BLUESKY_ENABLED,
  BLUESKY_HANDLE,
  BLUESKY_QUERY_DELAY_MS,
} from '../config.js';

const GAME_REFRESH_MS = 3 * 60 * 1000;     // 3 min, active hours
const BUZZ_REFRESH_MS = 5 * 60 * 1000;     // 5 min, active hours
const CHATTER_REFRESH_MS = 5 * 60 * 1000;  // 5 min, active hours
const ARTICLE_REFRESH_MS = 10 * 60 * 1000; // 10 min — articles update slowly
const OFF_REFRESH_MS = 10 * 60 * 1000;     // 10 min, off hours
const TICK_MS = 60 * 1000;                  // wake up once a minute
const HISTORY_TTL = 30 * 24 * 60 * 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mean of the n most-recent values in arr. Falls back to fewer values if
// arr is shorter than n. Used as the chatter-score baseline so the score
// reflects how much ppm has picked up vs the last few cycles.
function meanRecent(arr, n) {
  if (arr.length === 0) return 0;
  const recent = arr.slice(-n);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

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
      await saveHistory(game, { peakBuzz: peak });
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

// ── Chatter cycle (per-game Bluesky search → sticky peak chatter) ─────────────
//
// Unlike the buzz cycle, this does N HTTP requests per cycle (one per
// candidate game), spaced by BLUESKY_QUERY_DELAY_MS to stay under the public
// AppView's ~3000 req/5min/IP budget. Each game gets three independent
// scores: chatter, goodChatter, badChatter. Each score is the fold-increase
// of its ppm over the mean of the last 5 cycles, * 10 (1x → 10, 10x → 100,
// uncapped above that so viral surges stay distinguishable). The cached
// peak is the single snapshot from the cycle that overall chatter peaked
// on — good/bad in the peak reflect the sentiment of that moment, not the
// all-time max of those bucketed scores.

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
      // 5% chance to snapshot raw posts for a live game, at most once per game.
      const takeSample = game.live
        && Math.random() < 0.05
        && !(await getCache(`chatter-sample:${game.id}`));

      const prevChatter = await getCache(`chatter:${game.id}`);
      const current = await chatterForGame(game, {
        includeSample: takeSample,
        floorPpm:     meanRecent(prevChatter?.ppmHistory     ?? [], 5),
        floorGoodPpm: meanRecent(prevChatter?.goodPpmHistory ?? [], 5),
        floorBadPpm:  meanRecent(prevChatter?.badPpmHistory  ?? [], 5),
      });
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

const PPM_HISTORY_MAX = 20; // ~100 minutes of history at 5-min cycle

async function updatePeakChatter(game, current) {
  const key = `chatter:${game.id}`;
  const prev = await getCache(key);

  if (!current) {
    return { peak: prev || null, replaced: false };
  }

  // Append this cycle's readings to rolling history (used for floor next cycle).
  const ppmHistory     = [...(prev?.ppmHistory     ?? []), current.ppm    ].slice(-PPM_HISTORY_MAX);
  const goodPpmHistory = [...(prev?.goodPpmHistory ?? []), current.goodPpm].slice(-PPM_HISTORY_MAX);
  const badPpmHistory  = [...(prev?.badPpmHistory  ?? []), current.badPpm ].slice(-PPM_HISTORY_MAX);

  const histFields = { ppmHistory, goodPpmHistory, badPpmHistory };

  // Single sticky peak driven by overall chatter — when chatter sets a new
  // high, the whole snapshot (good/bad scores + raw counts) is replaced
  // together. goodChatter and badChatter in the peak therefore answer
  // "what sentiment was driving the moment chatter spiked?" rather than
  // "highest goodChatter/badChatter ever seen". The previous lock-in trap
  // (chatter capped at 100, peak frozen at cycle 2) is gone now that the
  // score is uncapped fold-increase.
  if (current.chatter > (prev?.chatter ?? -1)) {
    const peak = {
      ...current,
      ...histFields,
      recordedAt: new Date().toISOString(),
      wasLive: game.live,
    };
    await setCache(key, peak, CACHE_TTL.chatterPeak);
    return { peak, replaced: true };
  }

  // Chatter didn't peak but history advances — write back.
  const updated = { ...prev, ...histFields };
  await setCache(key, updated, CACHE_TTL.chatterPeak);
  return { peak: updated, replaced: false };
}

// Per-finished-game snapshot for review/leaderboards. Called from BOTH the
// buzz cycle and the chatter cycle, each passing only its own peak — we
// merge into one row so whichever cycle runs first creates the base record
// and the other overlays its fields. Buzz fields are namespaced under
// peakBuzz/peakGood/etc.; chatter fields under peakChatter/etc. so the two
// signals stay distinguishable in the audit data.
async function saveHistory(game, { peakBuzz, peakChatter } = {}) {
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

  const buzzFields = peakBuzz ? {
    peakBuzz:      peakBuzz.buzz ?? null,
    peakGoodBuzz:  peakBuzz.goodBuzz ?? null,
    peakBadBuzz:   peakBuzz.badBuzz ?? null,
    peakSentiment: peakBuzz.sentiment ?? null,
    peakComments:  peakBuzz.comments ?? null,
    peakVelocity:  peakBuzz.velocity ?? null,
    matchedPosts:  peakBuzz.matchedPosts ?? null,
    redditThread:  peakBuzz.threadUrl ?? null,
  } : {};

  const chatterFields = peakChatter ? {
    peakChatter:         peakChatter.chatter ?? null,
    peakGoodChatter:     peakChatter.goodChatter ?? null,
    peakBadChatter:      peakChatter.badChatter ?? null,
    peakPpm:             peakChatter.ppm ?? null,
    peakGoodPpm:         peakChatter.goodPpm ?? null,
    peakBadPpm:          peakChatter.badPpm ?? null,
    chatterMatchedPosts: peakChatter.matchedPosts ?? null,
    chatterGoodPosts:    peakChatter.goodPosts ?? null,
    chatterBadPosts:     peakChatter.badPosts ?? null,
    chatterLikes:        peakChatter.likes ?? null,
    chatterReposts:      peakChatter.reposts ?? null,
    chatterReplies:      peakChatter.replies ?? null,
  } : {};

  const row = {
    ...base,
    ...buzzFields,
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
let lastBuzzRun = 0;
let lastChatterRun = 0;
let lastArticleRun = 0;

function tick() {
  const gameInterval    = isOffHours() ? OFF_REFRESH_MS : GAME_REFRESH_MS;
  const buzzInterval    = isOffHours() ? OFF_REFRESH_MS : BUZZ_REFRESH_MS;
  const chatterInterval = isOffHours() ? OFF_REFRESH_MS : CHATTER_REFRESH_MS;
  const articleInterval = isOffHours() ? OFF_REFRESH_MS : ARTICLE_REFRESH_MS;
  const now = Date.now();

  if (now - lastGameRun >= gameInterval) {
    lastGameRun = now;
    runGameCycle();
  }
  if (REDDIT_ENABLED && now - lastBuzzRun >= buzzInterval) {
    lastBuzzRun = now;
    runBuzzCycle();
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
    `REDDIT_ENABLED=${REDDIT_ENABLED} (raw=${JSON.stringify(process.env.REDDIT_ENABLED)}) ` +
    `BLUESKY_ENABLED=${BLUESKY_ENABLED} (raw=${JSON.stringify(process.env.BLUESKY_ENABLED)}) ` +
    `BLUESKY_AUTH=${authConfigured() ? `configured(${BLUESKY_HANDLE})` : 'unset'} ` +
    `(handle_raw=${JSON.stringify(process.env.BLUESKY_HANDLE)} pw_set=${process.env.BLUESKY_APP_PASSWORD ? 'yes' : 'no'}) ` +
    `AUDIT_ENABLED=${AUDIT_ENABLED} (raw=${JSON.stringify(process.env.AUDIT_ENABLED)})`
  );
  await runGameCycle();
  if (REDDIT_ENABLED) {
    await runBuzzCycle();
  } else {
    console.log('[buzz] disabled (REDDIT_ENABLED != true) — skipping');
  }
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
