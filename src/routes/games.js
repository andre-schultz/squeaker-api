import express from 'express';
import { fetchAllGames } from '../services/espn.js';
import { getCache } from '../services/cache.js';
import { getStats, getStatsTimeline } from '../services/stats.js';
import { getApproxStats } from '../services/approxStats.js';
import { espnGamecastUrl } from '../config.js';

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

// In-flight fallback fetch, shared across concurrent cache-miss requests so a
// burst of traffic during an outage triggers at most one ESPN fan-out at a time.
let fallbackInflight = null;

// GET /api/games/days — the day index driving the date chips.
// [{ date: 'YYYY-MM-DD', count, live, sports: [...] }], newest day first.
router.get('/days', async (req, res) => {
  try {
    res.json((await getCache('games:index')) || []);
  } catch (e) {
    console.error('GET /api/games/days error:', e.message);
    res.status(500).json({ error: 'Failed to fetch days' });
  }
});

// GET /api/games
//   ?date=YYYY-MM-DD → that single ET day, sorted by excitement desc.
//   (no date)        → legacy flat list, capped to LEGACY_HOURS_WINDOW.
// Always served from cache. Falls back to live fetch if cache is empty.
router.get('/', async (req, res) => {
  try {
    const { date } = req.query;
    if (date !== undefined) {
      // Strict format check — the value becomes part of a Redis key.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }
      // An empty/missing shard is a legitimate answer (a day with no games, or
      // one aged out of the window), so return [] rather than falling back to
      // a live ESPN fetch that could not produce that day anyway.
      return res.json(withLinks((await getCache(`games:day:${date}`)) || []));
    }

    const cached = await getCache('games:all');
    if (cached && cached.length > 0) return res.json(withLinks(cached));

    // Cache miss — cold boot before the first warmup cycle, or the cycle has
    // been failing for longer than the TTL. Fetch live so the request is still
    // served, but do NOT write games:all: this list lacks done games older
    // than the ESPN date window (the warmup cycle composes those from its
    // in-memory store) and would clobber the authoritative list.
    console.log('[routes] Cache miss — fetching games live');
    if (!fallbackInflight) {
      fallbackInflight = fetchAllGames().finally(() => { fallbackInflight = null; });
    }
    const games = await fallbackInflight;
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

export default router;
