import { getCache, setCache } from './cache.js';
import { CACHE_TTL } from '../config.js';

const SUMMARY_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const STATS_TTL = CACHE_TTL.stats;

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
      const parseStat = (name, displayValue) => {
        const val = parseFloat(displayValue);
        stats[name] = isNaN(val) ? displayValue : val;
      };
      for (const s of team.statistics || []) {
        if (Array.isArray(s.stats)) {
          // MLB nested format: { name: 'batting', stats: [{name, displayValue}, ...] }
          for (const sub of s.stats) parseStat(`${s.name}_${sub.name}`, sub.displayValue);
        } else {
          parseStat(s.name, s.displayValue);
        }
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
// - stats-timeline:{gameId} — delta-compressed log: first entry is a full
//   snapshot, subsequent entries contain only fields that changed. To
//   reconstruct state at any point, merge entries in order (Object.assign).
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

  const timelineKey = `stats-timeline:${game.id}`;
  const existing    = (await getCache(timelineKey)) || [];

  let entry;
  if (existing.length === 0) {
    entry = snapshot;
  } else {
    const lastFull  = mergeDeltas(existing);
    const homeDiff  = diffFields(stats.home, lastFull.home || {});
    const awayDiff  = diffFields(stats.away, lastFull.away || {});
    const lastEntry = existing[existing.length - 1];
    if (Object.keys(homeDiff).length === 0 &&
        Object.keys(awayDiff).length === 0 &&
        lastEntry.live === game.live &&
        lastEntry.done === game.done) {
      entry = { t: snapshot.t }; // no changes — timestamp only
    } else {
      entry = { t: snapshot.t, live: game.live, done: game.done, home: homeDiff, away: awayDiff };
    }
  }

  await setCache(timelineKey, [...existing, entry], STATS_TTL);
  return snapshot;
}

// Merge all delta entries into a single reconstructed state object.
function mergeDeltas(entries) {
  const home = {}, away = {};
  for (const entry of entries) {
    Object.assign(home, entry.home || {});
    Object.assign(away, entry.away || {});
  }
  return { home, away };
}

// Return only the fields in current that differ from previous.
function diffFields(current, previous) {
  const diff = {};
  for (const [key, val] of Object.entries(current)) {
    if (JSON.stringify(val) !== JSON.stringify(previous[key] ?? null)) {
      diff[key] = val;
    }
  }
  return diff;
}

export async function getStats(gameId) {
  return await getCache(`stats:${gameId}`) || null;
}

export async function getStatsTimeline(gameId) {
  return await getCache(`stats-timeline:${gameId}`) || [];
}
