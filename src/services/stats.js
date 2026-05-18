import { getCache, setCache } from './cache.js';

const SUMMARY_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const STATS_TTL = 30 * 24 * 60 * 60; // 30 days

// Fetch team + goalie stats from ESPN's summary endpoint.
// Returns { home, away } with team stats and a goalies array, or null on failure.
export async function fetchGameStats(gameId, espnSport, espnLeague) {
  try {
    const url = `${SUMMARY_BASE}/${espnSport}/${espnLeague}/summary?event=${gameId}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Squeaker/1.0' } });
    if (!res.ok) {
      try { await res.text(); } catch {}
      return null;
    }
    const data = await res.json();
    const boxscore = data.boxscore;
    if (!boxscore) return null;

    const teamRows   = boxscore.teams   || [];
    const playerRows = boxscore.players || [];
    if (teamRows.length < 2) return null;

    const parseTeamStats = (team) => {
      const stats = {};
      for (const s of team.statistics || []) {
        const val = parseFloat(s.displayValue);
        stats[s.name] = isNaN(val) ? s.displayValue : val;
      }
      return stats;
    };

    const parseGoalies = (idx) => {
      const pg  = playerRows[idx];
      if (!pg) return [];
      const cat = pg.statistics?.find(c => c.name === 'goalies');
      if (!cat) return [];
      const keys = cat.keys || [];
      return (cat.athletes || []).map(a => {
        const obj = { name: a.athlete?.displayName || 'Unknown' };
        keys.forEach((k, i) => {
          const raw = a.stats?.[i];
          if (k === 'timeOnIce') { obj[k] = raw ?? null; return; }
          const val = parseFloat(raw);
          obj[k] = isNaN(val) ? (raw ?? null) : val;
        });
        return obj;
      });
    };

    const home = teamRows.find(t => t.homeAway === 'home');
    const away = teamRows.find(t => t.homeAway === 'away');
    if (!home || !away) return null;

    return {
      home: { ...parseTeamStats(home), goalies: parseGoalies(teamRows.indexOf(home)) },
      away: { ...parseTeamStats(away), goalies: parseGoalies(teamRows.indexOf(away)) },
    };
  } catch (e) {
    console.error(`[stats] fetch error for game ${gameId}:`, e.message);
    return null;
  }
}

// Fetch stats for a game and persist to Redis.
// - stats:{gameId}          — latest snapshot, overwritten each cycle
// - stats-timeline:{gameId} — append-only list, written only when shots change
// Returns the snapshot or null if ESPN returned nothing.
export async function recordStatsSnapshot(game, espnSport, espnLeague) {
  const stats = await fetchGameStats(game.id, espnSport, espnLeague);
  if (!stats) return null;

  const snapshot = {
    t:    Date.now(),
    live: game.live,
    done: game.done,
    home: stats.home,
    away: stats.away,
  };

  await setCache(`stats:${game.id}`, snapshot, STATS_TTL);

  // Only append to timeline when something meaningful changes — avoids duplicate
  // rows between plays. Uses shots for hockey, hits for other sports as a proxy,
  // falling back to a simple JSON diff if neither field is present.
  const timelineKey = `stats-timeline:${game.id}`;
  const existing    = (await getCache(timelineKey)) || [];
  const last        = existing[existing.length - 1];
  const changed     = !last || hasStatsChanged(last, snapshot);

  if (changed) {
    await setCache(timelineKey, [...existing, snapshot], STATS_TTL);
  }

  return snapshot;
}

// Detect a meaningful change between two snapshots so the timeline doesn't
// fill up with identical rows. Checks the most active counting stat available.
function hasStatsChanged(prev, curr) {
  const fields = ['shotsTotal', 'totalYards', 'totalOffensiveYards', 'hits', 'saves'];
  for (const f of fields) {
    if (prev.home[f] !== undefined) {
      return prev.home[f] !== curr.home[f] || prev.away[f] !== curr.away[f];
    }
  }
  // Fallback: compare full JSON (catches any stat change)
  return JSON.stringify(prev.home) !== JSON.stringify(curr.home)
      || JSON.stringify(prev.away) !== JSON.stringify(curr.away);
}

export async function getStats(gameId) {
  return await getCache(`stats:${gameId}`) || null;
}

export async function getStatsTimeline(gameId) {
  return await getCache(`stats-timeline:${gameId}`) || [];
}
