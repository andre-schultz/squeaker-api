import { fetchAllGames } from './espn.js';
import { fetchGameBuzz } from './reddit.js';
import { setCache, getCache } from './cache.js';
import { CACHE_TTL } from '../config.js';

const GAME_REFRESH_MS = 3  * 60 * 1000;  // 3 min
const BUZZ_REFRESH_MS = 10 * 60 * 1000;  // 10 min
const OFF_REFRESH_MS  = 10 * 60 * 1000;  // 10 min off hours
const HISTORY_TTL     = 30 * 24 * 60 * 60;
const DELAY           = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isOffHours() {
  const etHour = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false
  });
  const hour = parseInt(etHour);
  return hour >= 2 && hour < 9;
}

async function saveToHistory(game, buzz) {
  if (!game.done) return;
  const date = new Date(game.date).toISOString().slice(0, 10);
  const key  = `history:${date}:${game.id}`;
  const existing = await getCache(key);
  if (existing) return;

  const snapshot = {
    id:              game.id,
    date:            game.date,
    sport:           game.sport,
    sportName:       game.sportName,
    homeTeam:        game.home.name,
    awayTeam:        game.away.name,
    homeScore:       game.home.score,
    awayScore:       game.away.score,
    margin:          game.margin,
    isOT:            game.isOT,
    isComeback:      game.isComeback,
    excitementScore: game.excitement,
    excitementDesc:  game.desc,
    momentumBonus:   game.momentumBonus   ?? 0,
    momentumSignals: game.momentumSignals ?? [],
    buzzScore:       buzz?.buzz      ?? null,
    buzzSentiment:   buzz?.sentiment ?? null,
    buzzComments:    buzz?.comments  ?? null,
    buzzVelocity:    buzz?.velocity  ?? null,
    redditThread:    buzz?.threadUrl ?? null,
    savedAt:         new Date().toISOString(),
  };

  await setCache(key, snapshot, HISTORY_TTL);
  console.log(`[history] Saved ${game.away.abbr} vs ${game.home.abbr} (${date})`);
}

// Always fetch fresh buzz from Reddit.
// Only fall back to existing cache if Reddit call fails or returns nothing.
async function refreshBuzzForGame(game) {
  const cacheKey = `buzz:${game.id}`;
  try {
    const freshBuzz = await fetchGameBuzz(game);
    if (freshBuzz) {
      const ttl = game.live ? CACHE_TTL.buzzLive : CACHE_TTL.buzzFinished;
      await setCache(cacheKey, freshBuzz, ttl);
      console.log(`[buzz] Updated ${game.away.abbr} vs ${game.home.abbr}`);
      return freshBuzz;
    } else {
      console.log(`[buzz] No result for ${game.away.abbr} vs ${game.home.abbr} — keeping cache`);
      return await getCache(cacheKey); // return stale
    }
  } catch (e) {
    console.error(`[buzz] Error for ${game.id}:`, e.message);
    return await getCache(cacheKey); // return stale on error
  }
}

export async function warmCache() {
  console.log('[warmup] Starting cache warm...');
  try {
    const games   = await fetchAllGames();
    const hasLive = games.some(g => g.live);
    const gameTTL = hasLive ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
    await setCache('games:all', games, gameTTL);
    console.log(`[warmup] Cached ${games.length} games (TTL: ${gameTTL}s)`);

    // Fetch buzz for recent games
    const buzzCandidates = games.filter(g => {
      const ageHours = (Date.now() - new Date(g.date).getTime()) / 3600000;
      return ageHours <= 36;
    });
    console.log(`[warmup] Fetching buzz for ${buzzCandidates.length}/${games.length} games`);

    for (const game of buzzCandidates) {
      const buzz = await refreshBuzzForGame(game);
      await saveToHistory(game, buzz);
      await sleep(DELAY);
    }
    console.log('[warmup] Cache warm complete ✓');
  } catch (e) {
    console.error('[warmup] Cache warm failed:', e.message);
  }
}

async function scheduleGameRefresh() {
  const delay = isOffHours() ? OFF_REFRESH_MS : GAME_REFRESH_MS;
  setTimeout(async () => {
    try {
      const games   = await fetchAllGames();
      const hasLive = games.some(g => g.live);
      const ttl     = hasLive ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
      await setCache('games:all', games, ttl);
      console.log(`[schedule] Games refreshed (${games.length} games) — next in ${delay / 60000} min`);
    } catch (e) {
      console.error('[schedule] Game refresh failed:', e.message);
    }
    scheduleGameRefresh();
  }, delay);
}

async function scheduleBuzzRefresh() {
  const delay = isOffHours() ? OFF_REFRESH_MS : BUZZ_REFRESH_MS;
  setTimeout(async () => {
    try {
      const games = await fetchAllGames();
      const buzzCandidates = games.filter(g => {
        const ageHours = (Date.now() - new Date(g.date).getTime()) / 3600000;
        return ageHours <= 36;
      });
      for (const game of buzzCandidates) {
        const buzz = await refreshBuzzForGame(game);
        await saveToHistory(game, buzz);
        await sleep(DELAY);
      }
      console.log(`[schedule] Buzz refresh complete — next in ${delay / 60000} min`);
    } catch (e) {
      console.error('[schedule] Buzz refresh failed:', e.message);
    }
    scheduleBuzzRefresh();
  }, delay);
}

export function startWarmupSchedule() {
  warmCache();
  scheduleGameRefresh();
  scheduleBuzzRefresh();
}
