import express from 'express';
import { fetchAllGames } from '../services/espn.js';
import { getCache, setCache } from '../services/cache.js';
import { getStats, getStatsTimeline } from '../services/stats.js';
import { getApproxStats } from '../services/approxStats.js';
import { CACHE_TTL, espnGamecastUrl } from '../config.js';

const router = express.Router();

// Backfill the server-built "cast ↗" link on any cached game that predates the
// links field (frozen done-games, stale cache). Cheap, idempotent — leaves
// games that already carry links untouched.
function withLinks(games) {
  if (!Array.isArray(games)) return games;
  return games.map(g =>
    g && !g.links ? { ...g, links: { espn: espnGamecastUrl(g.sport, g.id) } } : g
  );
}

// GET /api/games
// Always served from cache. Falls back to live fetch if cache is empty.
router.get('/', async (req, res) => {
  try {
    const cached = await getCache('games:all');
    if (cached && cached.length > 0) return res.json(withLinks(cached));

    // Cache miss — fetch live and cache immediately
    console.log('[routes] Cache miss — fetching games live');
    const games   = await fetchAllGames();
    const hasLive = games.some(g => g.live);
    const ttl     = hasLive ? CACHE_TTL.liveGames : CACHE_TTL.finishedGames;
    if (games.length > 0) await setCache('games:all', games, ttl);
    res.json(withLinks(games));
  } catch (e) {
    console.error('GET /api/games error:', e.message);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

// GET /api/games/upcoming — scheduled games for today and tomorrow
router.get('/upcoming', async (req, res) => {
  try {
    const cached = await getCache('games:upcoming');
    res.json(withLinks(cached || []));
  } catch (e) {
    console.error('GET /api/games/upcoming error:', e.message);
    res.status(500).json({ error: 'Failed to fetch upcoming games' });
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

// GET /api/games/:id/stats — latest team + goalie stats snapshot (NHL only for now)
// Returns { t, live, done, home: { shotsTotal, hits, … goalies: [] }, away: { … } }
// or null if no stats have been fetched for this game yet.
router.get('/:id/stats', async (req, res) => {
  try {
    const stats = await getStats(req.params.id);
    res.json(stats || null);
  } catch (e) {
    console.error(`GET /api/games/${req.params.id}/stats error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/games/:id/stats-timeline — per-shot-change stats history for a game
// Returns an array of snapshots ordered oldest-first, one entry per shot count change.
router.get('/:id/stats-timeline', async (req, res) => {
  try {
    const timeline = await getStatsTimeline(req.params.id);
    res.json(timeline);
  } catch (e) {
    console.error(`GET /api/games/${req.params.id}/stats-timeline error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch stats timeline' });
  }
});

// GET /api/games/:id/approx-stats — fuzzed combined totals for finished games
// Returns { t, sport, approx: { goals, shots, … } } or null if not yet computed.
router.get('/:id/approx-stats', async (req, res) => {
  try {
    const data = await getApproxStats(req.params.id);
    res.json(data || null);
  } catch (e) {
    console.error(`GET /api/games/${req.params.id}/approx-stats error:`, e.message);
    res.status(500).json({ error: 'Failed to fetch approx stats' });
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
