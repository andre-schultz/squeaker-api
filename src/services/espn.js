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
      const res = await fetch(url, { headers: { 'User-Agent': 'Squeaker/1.0' } });
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of (data.events || [])) {
        const game = await parseEvent(ev, key, cfg);
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
  if (!done && !live) return null;

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

  const isOT = detail.includes('ot') ||
               detail.includes('overtime') ||
               detail.includes('extra time') ||
               detail.includes('penalties') ||
               (sportKey === 'mlb' && /f\/1[0-9]/.test(detail));

  // Game progress (0.0–1.0) — used to weight live excitement scores
  const progress = estimateProgress(sportKey, detail, comps);

  // Extract halftime scores for comeback detection
  const homeLines = home.linescores || [];
  const awayLines = away.linescores || [];
  const half      = Math.ceil(homeLines.length / 2);
  const halfHome  = homeLines.length >= 2
    ? homeLines.slice(0, half).reduce((s, p) => s + (parseFloat(p.value) || 0), 0)
    : null;
  const halfAway  = awayLines.length >= 2
    ? awayLines.slice(0, half).reduce((s, p) => s + (parseFloat(p.value) || 0), 0)
    : null;

  const isComeback = done ? detectComeback(halfHome, halfAway, margin, cfg) : false;

  // Build partial game object for snapshot recording
  const partialGame = {
    id: ev.id, sport: sportKey,
    home: { score: homeScore }, away: { score: awayScore },
    live, done,
  };

  // Record score snapshot for momentum tracking
  const timeline = await recordSnapshot(partialGame);

  // Analyze momentum from full scoring timeline
  const { momentumBonus, signals } = analyzeMomentum(timeline, { sport: sportKey });

  // For live games, scale by progress so early-game close scores don't rank too high
  const excitement = calcExcitement(margin, isOT, isComeback, cfg, momentumBonus, live ? progress : 1.0);

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
    id:              ev.id,
    sport:           sportKey,
    sportName:       cfg.name,
    sportEmoji:      cfg.emoji,
    home:            mkTeam(home, homeScore, home.winner),
    away:            mkTeam(away, awayScore, away.winner),
    margin,
    isOT,
    isComeback,
    momentumBonus,
    momentumSignals: signals,
    progress,
    gameStage:       rawDetail,
    done,
    live,
    excitement,
    desc:            excitementDesc(margin, isOT, isComeback, cfg),
    date:            ev.date,
    subreddit:       cfg.sub,
  };
}

// Returns date strings for today and the past 4 days (5 days total)
function getDateStrings() {
  const dates = [];
  for (let i = 0; i <= 4; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return dates;
}

// Estimates game progress 0.0–1.0 from status detail string
function estimateProgress(sportKey, detail, comps) {
  try {
    if (!detail || detail.includes('final') || detail.includes('ft')) return 1.0;

    if (['nfl', 'cfb'].includes(sportKey)) {
      const qtr  = detail.includes('1st') ? 1 : detail.includes('2nd') ? 2
                 : detail.includes('3rd') ? 3 : detail.includes('4th') ? 4 : null;
      const mins = parseMinutes(detail);
      if (qtr && mins !== null) return Math.min(1.0, ((qtr - 1) * 15 + (15 - mins)) / 60);
      if (detail.includes('half')) return 0.5;
      if (detail.includes('ot'))  return 1.0;
    }

    if (['nba', 'cbb'].includes(sportKey)) {
      const qtr  = detail.includes('1st') ? 1 : detail.includes('2nd') ? 2
                 : detail.includes('3rd') ? 3 : detail.includes('4th') ? 4 : null;
      const mins = parseMinutes(detail);
      if (sportKey === 'nba' && qtr && mins !== null) {
        return Math.min(1.0, ((qtr - 1) * 12 + (12 - mins)) / 48);
      }
      if (sportKey === 'cbb') {
        if (detail.includes('1st half')) return mins != null ? (20 - mins) / 40 : 0.25;
        if (detail.includes('2nd half')) return mins != null ? (40 - mins) / 40 : 0.75;
      }
      if (detail.includes('ot')) return 1.0;
    }

    if (sportKey === 'mlb') {
      const inning = parseInning(detail);
      if (inning) {
        const half = detail.includes('bot') ? 0.5 : 0;
        return Math.min(1.0, (inning - 1 + half) / 9);
      }
    }

    if (sportKey === 'nhl') {
      const per  = detail.includes('1st') ? 1 : detail.includes('2nd') ? 2
                 : detail.includes('3rd') ? 3 : null;
      const mins = parseMinutes(detail);
      if (per && mins !== null) return Math.min(1.0, ((per - 1) * 20 + (20 - mins)) / 60);
      if (detail.includes('ot')) return 1.0;
    }

    if (['mls', 'epl', 'ucl'].includes(sportKey)) {
      const minMatch = detail.match(/(\d+)'/);
      if (minMatch) return Math.min(1.0, parseInt(minMatch[1]) / 90);
      if (detail.includes('ht') || detail.includes('half time')) return 0.5;
    }
  } catch {}
  return 0.5;
}

function parseMinutes(detail) {
  const m = detail.match(/(\d+):(\d+)/);
  return m ? parseInt(m[1]) + parseInt(m[2]) / 60 : null;
}

function parseInning(detail) {
  const words = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th','11th','12th'];
  for (let i = 0; i < words.length; i++) {
    if (detail.includes(words[i])) return i + 1;
  }
  return null;
}
