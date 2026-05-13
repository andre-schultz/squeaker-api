// SportsGameOdds API — live in-game moneyline odds tracking.
//
// Polls SGO's /events?live=true endpoint every 10 minutes (matching their
// update frequency) and records a per-game WP timeline derived from the
// live moneyline. The opening baseline is seeded from ESPN's pre-game line
// (gameOdds:<id>) so the betting score has signal from the very first poll.
//
// Betting score (0-100) blends two signals:
//   drift    — total implied-WP movement from the opening line (overall story)
//   velocity — fastest WP shift in the recent 10-min window (what's happening now)
//
// SGO leagueIDs on the free tier: NHL, NBA, MLB, NFL, NCAAF, NCAAB, MLS, EPL,
// UEFA_CHAMPIONS_LEAGUE. Free tier: 2,500 objects/month, 1 object = 1 event.

import { getCache, setCache } from './cache.js';
import { CACHE_TTL } from '../config.js';

const BASE    = 'https://api.sportsgameodds.com/v2';
const HEADERS = () => ({ 'x-api-key': process.env.SGO_API_KEY, 'User-Agent': 'Squeaker/1.0' });

// Full-game moneyline oddIDs per the SGO docs:
// {statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}
const HOME_ML_ID = 'points-home-game-ml-home';
const AWAY_ML_ID = 'points-away-game-ml-away';

// SGO leagueID ↔ our sport key.
// EPL is blocked on the free tier — omitted intentionally.
const SGO_LEAGUE_TO_SPORT = {
  NHL:                  'nhl',
  NBA:                  'nba',
  MLB:                  'mlb',
  NFL:                  'nfl',
  NCAAF:                'cfb',
  NCAAB:                'cbb',
  MLS:                  'mls',
  UEFA_CHAMPIONS_LEAGUE:'ucl',
};
const SPORT_TO_SGO_LEAGUE = Object.fromEntries(
  Object.entries(SGO_LEAGUE_TO_SPORT).map(([k, v]) => [v, k])
);
const ALL_SGO_LEAGUES = Object.keys(SGO_LEAGUE_TO_SPORT).join(',');

// Rolling window for velocity calculation (matches SGO update frequency).
const BETTING_WINDOW_MS = 10 * 60_000;

// ── Public ─────────────────────────────────────────────────────────────────────

// Fetch live SGO events for the sports represented in liveGames.
//
// Makes one request per sport that has live games in our tracked list, limited
// to exactly the count we track for that sport. Keeps object usage proportional
// to what we actually care about — a March Madness night with 8 tracked NCAAB
// games costs 8 objects, not 40+. Some tracked games may not match if SGO
// returns different ones; betting score is best-effort coverage.
//
// Falls back to a single broad request when called without a game list (e.g.
// during warmup before games:all is populated).
export async function fetchSGOLiveEvents(liveGames = null) {
  if (!process.env.SGO_API_KEY) return [];

  if (!liveGames || liveGames.length === 0) {
    return fetchLeague(ALL_SGO_LEAGUES);
  }

  // Count how many live games we track per SGO league.
  const leagueCounts = {};
  for (const game of liveGames) {
    const league = SPORT_TO_SGO_LEAGUE[game.sport];
    if (league) leagueCounts[league] = (leagueCounts[league] || 0) + 1;
  }
  if (Object.keys(leagueCounts).length === 0) return [];

  // One request per active league, limited to the number of games we actually
  // track for that sport. SGO's return order isn't guaranteed so some tracked
  // games may not be in the response — betting score is best-effort.
  const results = await Promise.all(
    Object.entries(leagueCounts).map(([league, count]) => fetchLeague(league, count))
  );
  return results.flat();
}

// Single SGO /events request for one league. limit=null fetches all.
async function fetchLeague(leagueID, limit = null) {
  const params = new URLSearchParams({ live: 'true', leagueID, oddsAvailable: 'true' });
  if (limit != null) params.set('limit', String(limit));
  const url = `${BASE}/events?${params}`;
  let res;
  try {
    res = await fetch(url, { headers: HEADERS() });
  } catch {
    return [];
  }
  if (!res.ok) {
    try { await res.text(); } catch {}
    return [];
  }
  let data;
  try { data = await res.json(); } catch { return []; }
  if (!data?.success || !Array.isArray(data.data)) return [];
  return data.data;
}

// Record a live-odds snapshot for one ESPN game using the batch of SGO events
// already fetched this cycle (avoids redundant API calls per game).
// Returns the updated timeline, or null if the game has no SGO match.
export async function recordOddsSnapshot(game, sgoEvents) {
  const sgoEvent = matchSGOEvent(game, sgoEvents);
  if (!sgoEvent) return null;

  const parsed = parseML(sgoEvent);
  if (!parsed) return null;

  const key      = `odds-timeline:${game.id}`;
  const timeline = (await getCache(key)) || [];

  // Seed with ESPN pre-game line as opening baseline on first snapshot.
  // Both ESPN and SGO odds are vig-normalised via mlPairToWP so the WP
  // values are directly comparable across sources.
  if (timeline.length === 0) {
    const espnOdds = await getCache(`gameOdds:${game.id}`);
    if (espnOdds?.homeML != null && espnOdds?.awayML != null) {
      const baseline = mlPairToWP(espnOdds.homeML, espnOdds.awayML);
      if (baseline) {
        timeline.push({ t: Date.now(), ...baseline, isBaseline: true });
      }
    }
  }

  // Skip duplicate entries — only append when the line has moved by ≥0.5%,
  // unless the previous entry was the baseline (always record first live read).
  const last = timeline[timeline.length - 1];
  if (last && !last.isBaseline) {
    const dwp = Math.abs(parsed.homeWP - last.homeWP);
    if (dwp < 0.005) return timeline;
  }

  timeline.push({
    t:      Date.now(),
    homeWP: parsed.homeWP,
    awayWP: parsed.awayWP,
    homeML: parsed.homeML,
    awayML: parsed.awayML,
  });
  await setCache(key, timeline, CACHE_TTL.oddsTimeline);
  return timeline;
}

export async function getOddsTimeline(gameId) {
  return (await getCache(`odds-timeline:${gameId}`)) || [];
}

// 0–100 betting score.
//
// drift    — |currentHomeWP − openingHomeWP|; how much has the line moved
//            since the game started? Reflects the cumulative story.
// velocity — largest single-step WP change within the last BETTING_WINDOW_MS;
//            reflects what's happening right now.
//
// The ESPN pre-game baseline counts as the opener for drift when present.
// This is intentional for games tracked from the start — the baseline-to-live
// gap should be small and meaningful. For games picked up mid-way the score
// will be inflated, but the peak is guarded separately (requires ≥2 SGO reads)
// so mid-game cold-starts don't corrupt the peak.
//
// Calibration targets:
//   10% total drift                        → ~20 pts
//   25% total drift                        → ~50 pts
//   15% velocity in last 10 min            → ~45 pts
//   25% drift + 15% velocity (big swing)   → ~95 pts
export function computeBettingScore(timeline) {
  const result = {
    score:         0,
    drift:         0,
    velocity:      0,
    openingHomeWP: null,
    currentHomeWP: null,
    windowSamples: 0,
    windowMs:      BETTING_WINDOW_MS,
  };

  if (!timeline || timeline.length < 2) return result;

  const opening = timeline[0];
  const current = timeline[timeline.length - 1];
  result.openingHomeWP = opening.homeWP;
  result.currentHomeWP = current.homeWP;
  result.drift         = Math.abs(current.homeWP - opening.homeWP);

  // Velocity: largest |ΔWP| between consecutive samples in the recent window.
  const now    = Date.now();
  const recent = timeline.filter(s => now - s.t < BETTING_WINDOW_MS);
  result.windowSamples = recent.length;
  if (recent.length >= 2) {
    let maxDelta = 0;
    for (let i = 1; i < recent.length; i++) {
      const d = Math.abs(recent[i].homeWP - recent[i - 1].homeWP);
      if (d > maxDelta) maxDelta = d;
    }
    result.velocity = maxDelta;
  }

  const raw    = result.drift * 200 + result.velocity * 300;
  result.score = Math.min(100, Math.round(raw));
  return result;
}

// ── Internals ──────────────────────────────────────────────────────────────────

// Find the SGO event matching an ESPN game, first narrowing by sport then
// matching on normalised team names.
function matchSGOEvent(game, sgoEvents) {
  const sgoLeague  = SPORT_TO_SGO_LEAGUE[game.sport];
  const candidates = sgoLeague
    ? sgoEvents.filter(e => e.leagueID === sgoLeague)
    : sgoEvents;

  const homeNorm = normName(game.home.name);
  const awayNorm = normName(game.away.name);

  return candidates.find(e => {
    const sgoHome = normName(
      e.teams?.home?.names?.long || e.teams?.home?.names?.short || ''
    );
    const sgoAway = normName(
      e.teams?.away?.names?.long || e.teams?.away?.names?.short || ''
    );
    return namesMatch(homeNorm, sgoHome) && namesMatch(awayNorm, sgoAway);
  }) || null;
}

// Strip common soccer suffixes, punctuation, and extra whitespace so
// "Arsenal FC" and "Arsenal" both normalise to "arsenal".
function normName(name) {
  return name
    .toLowerCase()
    .replace(/\b(fc|sc|cf|af|ac|fk|sk)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Two team names match if they are equal, one contains the other, or they
// share at least one significant word (>3 chars). Handles "Warriors" vs
// "Golden State Warriors", "Man City" vs "Manchester City", etc.
function namesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const wordsB = new Set(b.split(' ').filter(w => w.length > 3));
  return a.split(' ').filter(w => w.length > 3).some(w => wordsB.has(w));
}

// Extract moneyline and normalised WP from a SGO event.
function parseML(sgoEvent) {
  const odds = sgoEvent.odds;
  if (!odds) return null;

  const homeML = extractML(odds[HOME_ML_ID]);
  const awayML = extractML(odds[AWAY_ML_ID]);
  if (homeML == null || awayML == null) return null;

  const wp = mlPairToWP(homeML, awayML);
  if (!wp) return null;
  return { homeML, awayML, ...wp };
}

// Walk a single oddID's byBookmaker map and return the first available ML.
// Odds may be returned as strings ("-110") so we parseFloat.
function extractML(oddEntry) {
  if (!oddEntry?.byBookmaker) return null;
  for (const bk of Object.values(oddEntry.byBookmaker)) {
    if (bk.available !== false && bk.odds != null) {
      const ml = parseFloat(bk.odds);
      if (!isNaN(ml) && ml !== 0) return ml;
    }
  }
  return null;
}

// American ML → raw implied probability (before vig removal).
function mlToRawProb(ml) {
  if (typeof ml !== 'number' || ml === 0) return null;
  return ml > 0 ? 100 / (ml + 100) : (-ml) / (-ml + 100);
}

// Convert a home+away ML pair to vig-normalised [0,1] probabilities so
// homeWP + awayWP = 1.0 regardless of the book's margin.
function mlPairToWP(homeML, awayML) {
  const rawHome = mlToRawProb(homeML);
  const rawAway = mlToRawProb(awayML);
  if (rawHome == null || rawAway == null) return null;
  const total = rawHome + rawAway;
  if (total === 0) return null;
  return { homeWP: rawHome / total, awayWP: rawAway / total };
}
