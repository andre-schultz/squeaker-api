import express from 'express';
import { getCache } from '../services/cache.js';

const router = express.Router();

// GET /api/games — always served from cache (pre-warmed on server start)
router.get('/', async (req, res) => {
  try {
    const games = await getCache('games:all');
    if (games) return res.json(games);
    // Cache miss (e.g. server just started) — return empty, warmup will fill it
    res.json([]);
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

export default router;
