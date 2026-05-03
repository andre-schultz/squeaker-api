import express from 'express';
import { fetchAllGames } from '../services/espn.js';
import { fetchGameBuzz } from '../services/reddit.js';
import { getCache, setCache } from '../services/cache.js';
import { CACHE_TTL } from '../config.js';

const router = express.Router();

// GET /api/games
// Returns all games from last 36 hours with excitement scores
// Buzz scores load separately via /api/games/:id/buzz
router.get('/', async (req, res) => {
  try {
    const cacheKey = 'games:all';
    const cached   = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const games = await fetchAllGames();

    // Cache duration depends on whether any games are live
    const hasLive = games.some(g => g.live);
    const ttl     = hasLive ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
    await setCache(cacheKey, games, ttl);

    res.json(games);
  } catch (e) {
    console.error('GET /api/games error:', e.message);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

// GET /api/games/:id/buzz
// Fetches Reddit buzz for a single game — called per-game after initial load
router.get('/:id/buzz', async (req, res) => {
  const { id } = req.params;

  try {
    const cacheKey = `buzz:${id}`;
    const cached   = await getCache(cacheKey);
    if (cached) return res.json(cached);

    // Find the game to get its details
    const games = await fetchAllGames();
    const game  = games.find(g => g.id === id);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const buzz = await fetchGameBuzz(game);
    if (!buzz) return res.json({ buzz: null });

    // Cache buzz — shorter TTL for live games
    const ttl = game.live ? CACHE_TTL.buzzLive : CACHE_TTL.buzzFinished;
    await setCache(cacheKey, buzz, ttl);

    res.json(buzz);
  } catch (e) {
    console.error(`GET /api/games/${id}/buzz error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch buzz' });
  }
});

export default router;
