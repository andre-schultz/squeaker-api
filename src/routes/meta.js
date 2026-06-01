import express from 'express';
import { SPORTS } from '../config.js';
import { getTeamsForLeague, getConferences, searchTeams } from '../services/teams.js';

const router = express.Router();

// GET /api/leagues — league metadata for client tab strips, sport filters, and
// marketing copy. Derived from the SPORTS config so it's the single source of
// truth: add a league there and every client picks it up with no redeploy.
// `hasConferences` tells clients to show a conference sub-filter for that league.
router.get('/leagues', (req, res) => {
  const leagues = Object.entries(SPORTS).map(([key, cfg]) => ({
    key,
    name:           cfg.name,
    emoji:          cfg.emoji,
    hasConferences: !!cfg.conference,
  }));
  res.json(leagues);
});

// GET /api/conferences?league=<key> — conferences for a college league.
// [] for leagues without conference grouping.
router.get('/conferences', async (req, res) => {
  try {
    const league = req.query.league;
    if (!league) return res.status(400).json({ error: 'league query param required' });
    const conferences = await getConferences(league);
    if (conferences === null) return res.status(404).json({ error: 'Unknown league' });
    res.json(conferences);
  } catch (e) {
    console.error('GET /api/conferences error:', e.message);
    res.status(500).json({ error: 'Failed to fetch conferences' });
  }
});

// GET /api/teams/search?q=… — cross-league team name search (cached index).
// Declared before /teams so the literal path wins regardless of matcher order.
router.get('/teams/search', async (req, res) => {
  try {
    res.json(await searchTeams(req.query.q));
  } catch (e) {
    console.error('GET /api/teams/search error:', e.message);
    res.status(500).json({ error: 'Failed to search teams' });
  }
});

// GET /api/teams?league=<key>[&conference=<id>] — one league's teams, each with
// a CDN logo URL. Fetched lazily so a client only loads the roster it's showing;
// for college leagues, `conference` narrows to ~12–18 teams.
router.get('/teams', async (req, res) => {
  try {
    const league = req.query.league;
    if (!league) return res.status(400).json({ error: 'league query param required' });
    const teams = await getTeamsForLeague(league, req.query.conference);
    if (teams === null) return res.status(404).json({ error: 'Unknown league' });
    res.json(teams);
  } catch (e) {
    console.error('GET /api/teams error:', e.message);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

export default router;
