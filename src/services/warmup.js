import { fetchAllGames } from './espn.js';
import { fetchGameBuzz } from './reddit.js';
import { setCache } from './cache.js';
import { CACHE_TTL } from '../config.js';

const GAME_REFRESH_MS = 10 * 60 * 1000;  // 10 min — scores
const BUZZ_REFRESH_MS = 15 * 60 * 1000;  // 15 min — buzz

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
        // Small delay between Reddit calls to be a good citizen
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

  // Then refresh games every 10 min
  setInterval(async () => {
    try {
      const games = await fetchAllGames();
      const hasLive = games.some(g => g.live);
      const ttl = hasLive ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
      await setCache('games:all', games, ttl);
      console.log(`[schedule] Games refreshed (${games.length} games)`);
    } catch (e) {
      console.error('[schedule] Game refresh failed:', e.message);
    }
  }, GAME_REFRESH_MS);

  // Refresh buzz every 15 min
  setInterval(async () => {
    try {
      const games = await fetchAllGames();
      for (const game of games) {
        try {
          const buzz = await fetchGameBuzz(game);
          if (buzz) {
            const ttl = game.live ? CACHE_TTL.buzzLive : CACHE_TTL.buzzFinished;
            await setCache(`buzz:${game.id}`, buzz, ttl);
          }
          await sleep(500);
        } catch (e) {
          console.error(`[schedule] Buzz refresh failed for ${game.id}:`, e.message);
        }
      }
      console.log('[schedule] Buzz refresh complete');
    } catch (e) {
      console.error('[schedule] Buzz refresh failed:', e.message);
    }
  }, BUZZ_REFRESH_MS);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
