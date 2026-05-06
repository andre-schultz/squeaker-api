import express from 'express';
import { fetchAllGames } from '../services/espn.js';
import { getCache, setCache } from '../services/cache.js';
import { CACHE_TTL } from '../config.js';

const router = express.Router();

// GET /api/games
// Always served from cache. Falls back to live fetch if cache is empty.
router.get('/', async (req, res) => {
  try {
    const cached = await getCache('games:all');
    if (cached && cached.length > 0) return res.json(cached);

    // Cache miss — fetch live and cache immediately
    console.log('[routes] Cache miss — fetching games live');
    const games   = await fetchAllGames();
    const hasLive = games.some(g => g.live);
    const ttl     = hasLive ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
    if (games.length > 0) await setCache('games:all', games, ttl);
    res.json(games);
  } catch (e) {
    console.error('GET /api/games error:', e.message);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

// GET /api/games/:id/buzz — always served from cache
router.get('/:id/buzz', async (req, res) => {
  try {
    const buzz = await getCache(`buzz:${req.params.id}`);
    if (buzz) return res.json(buzz);
    res.json({ buzz: null });
  } catch (e) {
    console.error(`GET /api/games/${req.params.id}/buzz error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch buzz' });
  }
});

// GET /api/games/:id/articles — ESPN editorial coverage for a game
// Returns { count, articles: [{ headline, url, type, published, image, ... }] }
router.get('/:id/articles', async (req, res) => {
  try {
    const articles = await getCache(`articles:${req.params.id}`);
    if (articles) return res.json(articles);
    res.json({ count: 0, articles: [] });
  } catch (e) {
    console.error(`GET /api/games/${req.params.id}/articles error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

export default router;
