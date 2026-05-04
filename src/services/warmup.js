import { fetchAllGames } from './espn.js';
import { fetchGameBuzz } from './reddit.js';
import { setCache, getCache } from './cache.js';
import { CACHE_TTL } from '../config.js';

const GAME_REFRESH_MS  = 10 * 60 * 1000;
const BUZZ_REFRESH_MS  = 15 * 60 * 1000;
const OFF_REFRESH_MS   = 60 * 60 * 1000;
const HISTORY_TTL      = 30 * 24 * 60 * 60; // 30 days in seconds

function isOffHours() {
  const etHour = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  return parseInt(etHour) >= 2 && parseInt(etHour) < 9;
}

// Save a completed game snapshot for algorithm training
async function saveToHistory(game, buzz) {
  if (!game.done) return; // only save finished games
  const date    = new Date(game.date).toISOString().slice(0, 10);
  const key     = `history:${date}:${game.id}`;

  // Don't overwrite if already saved
  const existing = await getCache(key);
  if (existing) return;

  const snapshot = {
    id:            game.id,
    date:          game.date,
    sport:         game.sport,
    sportName:     game.sportName,
    homeTeam:      game.home.name,
    awayTeam:      game.away.name,
    homeScore:     game.home.score,
    awayScore:     game.away.score,
    margin:        game.margin,
    isOT:          game.isOT,
    isComeback:    game.isComeback,
    excitementScore: game.excitement,
    excitementDesc:  game.desc,
    buzzScore:     buzz?.buzz     ?? null,
    buzzSentiment: buzz?.sentiment ?? null,
    buzzComments:  buzz?.comments  ?? null,
    buzzVelocity:  buzz?.velocity  ?? null,
    redditThread:  buzz?.threadUrl ?? null,
    savedAt:       new Date().toISOString(),
  };

  await setCache(key, snapshot, HISTORY_TTL);
  console.log(`[history] Saved ${game.away.abbr} vs ${game.home.abbr} (${date})`);
}

// Run on server start and on a schedule
export async function warmCache() {
  console.log('[warmup] Starting cache warm...');
  try {
    // 1. Fetch and cache all games
    const games = await fetchAllGames();
    const hasLive = games.some(g => g.live);
    const gameTTL = hasLive ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
    await setCache('games:all', games, gameTTL);
    console.log(`[warmup] Cached ${games.length} games (TTL: ${gameTTL}s)`);

    // 2. Fetch and cache buzz for every game, sequentially to respect Reddit rate limits
    for (const game of games) {
      try {
        const buzz = await fetchGameBuzz(game);
        if (buzz) {
          const buzzTTL = game.live ? CACHE_TTL.buzzLive : CACHE_TTL.buzzFinished;
          await setCache(`buzz:${game.id}`, buzz, buzzTTL);
          console.log(`[warmup] Buzz cached for ${game.away.abbr} vs ${game.home.abbr}`);
        }
        // Save finished games to history for algorithm training
        await saveToHistory(game, buzz);
        await sleep(500);
      } catch (e) {
        console.error(`[warmup] Buzz failed for game ${game.id}:`, e.message);
      }
    }
    console.log('[warmup] Cache warm complete ✓');
  } catch (e) {
    console.error('[warmup] Cache warm failed:', e.message);
  }
}

// Start recurring warm on a schedule
export function startWarmupSchedule() {
  // Warm immediately on start
  warmCache();

  // Self-scheduling game refresh — checks off hours each cycle
  async function scheduleGameRefresh() {
    const delay = isOffHours() ? OFF_REFRESH_MS : GAME_REFRESH_MS;
    setTimeout(async () => {
      try {
        const games  = await fetchAllGames();
        const hasLive = games.some(g => g.live);
        const ttl    = hasLive ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
        await setCache('games:all', games, ttl);
        console.log(`[schedule] Games refreshed (${games.length} games) — next in ${delay/60000} min`);
      } catch (e) {
        console.error('[schedule] Game refresh failed:', e.message);
      }
      scheduleGameRefresh(); // schedule next cycle
    }, delay);
  }

  // Self-scheduling buzz refresh — checks off hours each cycle
  async function scheduleBuzzRefresh() {
    const delay = isOffHours() ? OFF_REFRESH_MS : BUZZ_REFRESH_MS;
    setTimeout(async () => {
      try {
        const games = await fetchAllGames();
        for (const game of games) {
          try {
            const buzz = await fetchGameBuzz(game);
            if (buzz) {
              const ttl = game.live ? CACHE_TTL.buzzLive : CACHE_TTL.buzzFinished;
              await setCache(`buzz:${game.id}`, buzz, ttl);
            }
            // Save finished games to history for algorithm training
            await saveToHistory(game, buzz);
            await sleep(500);
          } catch (e) {
            console.error(`[schedule] Buzz refresh failed for ${game.id}:`, e.message);
          }
        }
        console.log(`[schedule] Buzz refresh complete — next in ${delay/60000} min`);
      } catch (e) {
        console.error('[schedule] Buzz refresh failed:', e.message);
      }
      scheduleBuzzRefresh(); // schedule next cycle
    }, delay);
  }

  scheduleGameRefresh();
  scheduleBuzzRefresh();
}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));