import fetch from 'node-fetch';
import { SPORTS, HOURS_WINDOW } from '../config.js';
import { calcExcitement, detectComeback, excitementDesc } from './algorithm.js';
import { recordSnapshot, getTimeline, analyzeMomentum } from './timeline.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// Fetch all games across all sports within the time window
export async function fetchAllGames() {
  const dates = getDateStrings();
  const results = await Promise.all(
    Object.entries(SPORTS).map(([key, cfg]) => fetchSport(key, cfg, dates))
  );
  // Flatten, dedupe by id, sort by excitement desc
  const seen  = new Set();
  const games = results.flat().filter(g => {
    if (seen.has(g.id)) return false;
    seen.add(g.id);
    return true;
  });
  return games.sort((a, b) => b.excitement - a.excitement);
}

async function fetchSport(key, cfg, dates) {
  const games = [];
  for (const date of dates) {
    try {
      const url = `${BASE}/${cfg.espnSport}/${cfg.espnLeague}/scoreboard${date ? `?dates=${date}` : ''}`;
      const res  = await fetch(url, { headers: { 'User-Agent': 'Squeaker/1.0' } });
      if (!res.ok) continue;
      const data = await res.json();

      for (const ev of (data.events || [])) {
        const game = await parseEvent(ev, key, cfg); // now async
        if (game) games.push(game);
      }
    } catch (e) {
      console.error(`ESPN fetch error [${key}]:`, e.message);
    }
  }
  return games;
}

async function parseEvent(ev, sportKey, cfg) {
  const co = ev.competitions?.[0];
  if (!co) return null;

  const status = co.status?.type;
  const done   = !!status?.completed;
  const live   = !done && status?.state === 'in';
  if (!done && !live) return null; // upcoming — skip

  // Filter to time window
  const gameTime = new Date(ev.date);
  const cutoff   = new Date(Date.now() - HOURS_WINDOW * 60 * 60 * 1000);
  if (gameTime < cutoff) return null;

  const comps = co.competitors || [];
  const home  = comps.find(c => c.homeAway === 'home');
  const away  = comps.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const homeScore = parseFloat(home.score) || 0;
  const awayScore = parseFloat(away.score) || 0;
  const margin    = Math.abs(homeScore - awayScore);

  const detail    = (status?.shortDetail || '').toLowerCase();
  const rawDetail = status?.shortDetail || '';
  const isOT   = detail.includes('ot') ||
                 detail.includes('overtime') ||
                 detail.includes('extra time') ||
                 detail.includes('penalties') ||
                 (sportKey === 'mlb' && /f\/1[0-9]/.test(detail));

  // Game progress (0.0–1.0) — used to weight live excitement scores
  const progress = estimateProgress(sportKey, detail, comps); // F/10, F/11 etc

  // Extract halftime scores for comeback detection
  const homeLines  = home.linescores || [];
  const awayLines  = away.linescores || [];
  const half       = Math.ceil(homeLines.length / 2);
  const halfHome   = homeLines.length >= 2
    ? homeLines.slice(0, half).reduce((s, p) => s + (parseFloat(p.value) || 0), 0)
    : null;
  const halfAway   = awayLines.length >= 2
    ? awayLines.slice(0, half).reduce((s, p) => s + (parseFloat(p.value) || 0), 0)
    : null;

  const isComeback = done ? detectComeback(halfHome, halfAway, margin, cfg) : false;
  const excitement = calcExcitement(margin, isOT, isComeback, cfg, momentumBonus, live ? progress : 1.0);

  // Build partial game object for snapshot recording
  const partialGame = {
    id: ev.id, sport: sportKey,
    home: { score: homeScore }, away: { score: awayScore },
    live, done,
  };

  // Record score snapshot for momentum tracking (live and finished games)
  const timeline = await recordSnapshot(partialGame);

  // Analyze momentum from full scoring timeline
  const { momentumBonus, signals } = analyzeMomentum(timeline, { sport: sportKey });

  const excitement = calcExcitement(margin, isOT, isComeback, cfg, momentumBonus);

  const mkTeam = (T, score, winner) => ({
    name:     T.team.shortDisplayName || T.team.displayName,
    fullName: T.team.displayName,
    abbr:     T.team.abbreviation,
    logo:     T.team.logo,
    color:    T.team.color ? `#${T.team.color}` : '#374151',
    score,
    winner:   !!winner,
  });

  return {
    id:          ev.id,
    sport:       sportKey,
    sportName:   cfg.name,
    sportEmoji:  cfg.emoji,
    home:        mkTeam(home, homeScore, home.winner),
    away:        mkTeam(away, awayScore, away.winner),
    margin,
    isOT,
    isComeback,
    momentumBonus,
    momentumSignals: signals,
    progress,
    gameStage: rawDetail,
    done,
    live,
    excitement,
    desc:        excitementDesc(margin, isOT, isComeback, cfg),
    date:        ev.date,
    subreddit:   cfg.sub,
  };
}

// Returns today and yesterday as YYYYMMDD strings
function getDateStrings() {
  const dates = [];
  for (let i = 0; i <= 1; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return dates;
}
