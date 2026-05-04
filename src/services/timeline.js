import { getCache, setCache } from './cache.js';

const TIMELINE_TTL = 30 * 24 * 60 * 60; // 30 days — keep for algorithm training

// Snapshot the current score for a live or recently finished game
export async function recordSnapshot(game) {
  const key      = `timeline:${game.id}`;
  const existing = await getCache(key) || [];

  const latest = existing[existing.length - 1];
  const homeScore = Math.round(game.home.score);
  const awayScore = Math.round(game.away.score);

  // Only record if score changed or it's the first snapshot
  if (latest && latest.home === homeScore && latest.away === awayScore) return existing;

  const snapshot = {
    t:    Date.now(),           // timestamp
    home: homeScore,
    away: awayScore,
    live: game.live,
    done: game.done,
  };

  const updated = [...existing, snapshot];
  await setCache(key, updated, TIMELINE_TTL);
  return updated;
}

// Load the full timeline for a game
export async function getTimeline(gameId) {
  return await getCache(`timeline:${gameId}`) || [];
}

// Analyze timeline to produce momentum scoring signals
export function analyzeMomentum(timeline, sport) {
  if (!timeline || timeline.length < 2) {
    return { momentumBonus: 0, signals: [] };
  }

  const signals  = [];
  let bonus      = 0;

  const first    = timeline[0];
  const last     = timeline[timeline.length - 1];
  const duration = last.t - first.t; // total time tracked in ms
  const lateWindow = duration * 0.25; // last 25% of game = "late"
  const lateStart  = last.t - lateWindow;

  let leadChanges    = 0;
  let tiedDuration   = 0;
  let closeDuration  = 0; // within 1 score
  let lateGoals      = 0;
  let prevLeader     = getLeader(first.home, first.away);

  for (let i = 1; i < timeline.length; i++) {
    const prev    = timeline[i - 1];
    const curr    = timeline[i];
    const segMs   = curr.t - prev.t;
    const margin  = Math.abs(curr.home - curr.away);
    const leader  = getLeader(curr.home, curr.away);
    const isLate  = curr.t >= lateStart;

    // Track time spent tied
    if (margin === 0) tiedDuration += segMs;

    // Track time spent close (within 1 score/goal)
    if (margin <= closenessThreshold(sport)) closeDuration += segMs;

    // Detect lead change
    if (leader !== 'tied' && prevLeader !== 'tied' && leader !== prevLeader) {
      leadChanges++;
      if (isLate) {
        signals.push('Late lead change');
        bonus += 8;
      }
    }

    // Detect goal/score in late window
    const scored = (curr.home + curr.away) > (prev.home + prev.away);
    if (scored && isLate) {
      lateGoals++;
      const wasClose = Math.abs(prev.home - prev.away) <= closenessThreshold(sport);
      if (wasClose) {
        signals.push('Late goal in close game');
        bonus += 10;
      } else if (margin === 0) {
        signals.push('Late equalizer');
        bonus += 12;
      } else if (margin <= closenessThreshold(sport)) {
        signals.push('Late go-ahead goal');
        bonus += 10;
      }
    }

    prevLeader = leader !== 'tied' ? leader : prevLeader;
  }

  // Bonus for lots of time spent tied or close
  const tiedPct  = tiedDuration / duration;
  const closePct = closeDuration / duration;

  if (tiedPct > 0.5) {
    signals.push('Game was tied for majority of time');
    bonus += 8;
  } else if (closePct > 0.6) {
    signals.push('Game was close for majority of time');
    bonus += 5;
  }

  // Bonus for multiple lead changes
  if (leadChanges >= 3) {
    signals.push(`${leadChanges} lead changes`);
    bonus += 6;
  } else if (leadChanges >= 2) {
    signals.push(`${leadChanges} lead changes`);
    bonus += 3;
  }

  return { momentumBonus: Math.min(bonus, 20), signals }; // cap momentum bonus at 20
}

function getLeader(home, away) {
  if (home > away) return 'home';
  if (away > home) return 'away';
  return 'tied';
}

// Sport-specific "close" threshold (within this many points = close)
function closenessThreshold(sport) {
  const thresholds = {
    nba: 5, nfl: 7, mlb: 1, nhl: 1,
    mls: 1, epl: 1, ucl: 1, cfb: 7, cbb: 5,
  };
  return thresholds[sport?.sport || sport] ?? 2;
}
