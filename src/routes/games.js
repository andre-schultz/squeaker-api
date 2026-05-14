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

// GET /api/games/:id/chatter — Bluesky chatter peak (sticky high-water mark)
// Returns { chatter, engagedCount, avgEngagement, matchedPosts, ... } or
// { chatter: null } if no chatter has been recorded for this game.
router.get('/:id/chatter', async (req, res) => {
  try {
    const chatter = await getCache(`chatter:${req.params.id}`);
    if (chatter) return res.json(chatter);
    res.json({ chatter: null });
  } catch (e) {
    console.error(`GET /api/games/${req.params.id}/chatter error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch chatter' });
  }
});

// GET /api/games/:id/chatter-sample — raw post snapshot taken during a live game
// Returns { gameLabel, sampledAt, posts: [{ text, likes, reposts, replies, bad, good }] }
// or { posts: null } if no sample has been taken for this game.
router.get('/:id/chatter-sample', async (req, res) => {
  try {
    const sample = await getCache(`chatter-sample:${req.params.id}`);
    if (sample) return res.json(sample);
    res.json({ posts: null });
  } catch (e) {
    console.error(`GET /api/games/${req.params.id}/chatter-sample error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch chatter sample' });
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

// GET /api/games/:id/wp — win-probability timeline + drama summary
// Returns { timeline: [{ t, homeWP, awayWP }], … }
router.get('/:id/wp', async (req, res) => {
  try {
    const timeline = await getCache(`probabilities:${req.params.id}`);
    res.json({ timeline: timeline || [] });
  } catch (e) {
    console.error(`GET /api/games/${req.params.id}/wp error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch wp' });
  }
});

// GET /api/games/:id/audit — algorithm audit log (when AUDIT_ENABLED was on)
// Returns the full per-cycle snapshot list (up to 200 entries, last 3 days)
router.get('/:id/audit', async (req, res) => {
  try {
    const audit = await getCache(`audit:${req.params.id}`);
    res.json({ snapshots: audit || [] });
  } catch (e) {
    console.error(`GET /api/games/${req.params.id}/audit error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch audit' });
  }
});

// GET /api/games/:id/betting — live betting score derived from SGO line movement
// Returns { current, peak, drift, velocity, openingHomeWP, currentHomeWP, ... }
// or { current: null } when SGO has no data for this game.
router.get('/:id/betting', async (req, res) => {
  try {
    const data = await getCache(`betting:${req.params.id}`);
    res.json(data || { current: null });
  } catch (e) {
    console.error(`GET /api/games/${req.params.id}/betting error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch betting data' });
  }
});

export default router;
