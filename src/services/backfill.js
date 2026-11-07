// ── Score-timeline backfill from ESPN play-by-play ────────────────────────────
// The score timeline (timeline:{id}) is normally built by polling: one snapshot
// per game cycle whenever the score changed. That only sees what happened while
// we were watching. A game first observed mid-game (league outage, process
// restart, a league coming out of dormancy) has a timeline that starts at
// whatever the score was then — and a game first observed already finished has
// a single final-score snapshot. Momentum and comeback then miss everything
// before that point, so those games score systematically low.
//
// A complete timeline always opens at 0-0. When it doesn't, rebuild it from the
// ESPN /summary scoring plays, which cover the whole game.

import { setCache } from './cache.js';
import { CACHE_TTL, isSoccer } from '../config.js';

const SUMMARY_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const HEADERS = { 'User-Agent': 'Squeaker/1.0' };

// Regulation shape per sport, for turning (period, clock) into 0–1 progress.
const FORMAT = {
  nfl:  { periods: 4, minutes: 15 },
  cfb:  { periods: 4, minutes: 15 },
  nba:  { periods: 4, minutes: 12 },
  wnba: { periods: 4, minutes: 10 },
  wcbb: { periods: 4, minutes: 10 },
  cbb:  { periods: 2, minutes: 20 },
  nhl:  { periods: 3, minutes: 20 },
};

// Failed attempts per game, so a game whose summary has no usable plays is not
// re-fetched every cycle. Pruned with the other per-game stores.
const MAX_ATTEMPTS = 3;
const _attempts = new Map(); // gameId → failed attempt count

export function pruneBackfill(id) {
  _attempts.delete(id);
}

// True when a timeline is missing the start of the game.
export function timelineHasGap(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) return true;
  const first = timeline[0];
  return (first.home || 0) + (first.away || 0) > 0;
}

// Minutes left on the period clock, from a play's clock object.
function clockMinutes(clock) {
  const dv = clock?.displayValue;
  if (typeof dv === 'string') {
    const m = dv.match(/^(\d+):(\d+)/);
    if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
    const s = dv.match(/^(\d+(?:\.\d+)?)$/);
    if (s) return parseFloat(s[1]) / 60;
  }
  if (typeof clock?.value === 'number') return clock.value / 60;
  return null;
}

// 0–1 progress at the moment of a play. Overtime counts as 1.0 (matches
// estimateProgress in espn.js).
function playProgress(sportKey, play) {
  const period = play?.period?.number;
  if (!Number.isFinite(period) || period < 1) return null;

  if (sportKey === 'mlb') {
    const half = /bot/i.test(play.period?.type || play.period?.displayValue || '') ? 0.5 : 0;
    return Math.min(1, (period - 1 + half) / 9);
  }

  const fmt = FORMAT[sportKey];
  if (!fmt) return null;
  if (period > fmt.periods) return 1.0;
  const left = clockMinutes(play.clock);
  const intoPeriod = left == null ? fmt.minutes / 2 : Math.max(0, Math.min(fmt.minutes, fmt.minutes - left));
  return Math.min(1, ((period - 1) * fmt.minutes + intoPeriod) / (fmt.periods * fmt.minutes));
}

// Build a 0-0-anchored score timeline from a /summary payload, or null when the
// payload has no usable scoring plays. Pure — exported for testing.
export function timelineFromSummary(data, sportKey, startMs) {
  const raw = Array.isArray(data?.scoringPlays) && data.scoringPlays.length
    ? data.scoringPlays
    : (Array.isArray(data?.plays) ? data.plays.filter(p => p?.scoringPlay) : []);
  if (!raw.length) return null;

  const t0 = Number.isFinite(startMs) ? startMs : Date.now();
  const timeline = [{ t: t0, home: 0, away: 0, progress: 0, live: true, done: false }];
  let lastProg = 0;

  for (const p of raw) {
    const home = Number(p?.homeScore);
    const away = Number(p?.awayScore);
    if (!Number.isFinite(home) || !Number.isFinite(away)) continue;
    const prev = timeline[timeline.length - 1];
    if (home === prev.home && away === prev.away) continue; // e.g. a missed PAT row

    // Progress must never run backwards (clock quirks, out-of-order rows).
    let progress = playProgress(sportKey, p);
    if (progress == null) progress = lastProg;
    progress = Math.max(lastProg, progress);
    lastProg = progress;

    timeline.push({
      t: t0 + Math.round(progress * 4 * 60 * 60 * 1000), // nominal; progress drives analysis
      home, away, progress, live: true, done: false,
    });
  }

  return timeline.length > 1 ? timeline : null;
}

// Rebuild a game's timeline from play-by-play when the polled one has a gap.
// Returns the timeline to use (backfilled, or the original on any failure).
//   game     — { id, sport, live, done, progress, home:{score}, away:{score} }
//   timeline — the polled timeline from recordSnapshot()
export async function backfillTimeline(game, timeline, espnSport, espnLeague, startDate) {
  if (!timelineHasGap(timeline)) return timeline;
  if (isSoccer(game.sport)) return timeline; // soccer summaries carry no running score
  if ((_attempts.get(game.id) || 0) >= MAX_ATTEMPTS) return timeline;

  let data;
  try {
    const url = `${SUMMARY_BASE}/${espnSport}/${espnLeague}/summary?event=${game.id}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { try { await res.text(); } catch {} throw new Error(`HTTP ${res.status}`); }
    data = await res.json();
  } catch (e) {
    _attempts.set(game.id, (_attempts.get(game.id) || 0) + 1);
    console.error(`[backfill] summary fetch failed for ${game.sport} ${game.id}:`, e.message);
    return timeline;
  }

  const rebuilt = timelineFromSummary(data, game.sport, Date.parse(startDate));
  const homeNow = Math.round(game.home.score);
  const awayNow = Math.round(game.away.score);
  const last = rebuilt?.[rebuilt.length - 1];

  // Sanity check: play-by-play must agree with the scoreboard, or at least not
  // be ahead of it (the summary can lag a live scoreboard by a play).
  if (!last || last.home > homeNow || last.away > awayNow) {
    _attempts.set(game.id, (_attempts.get(game.id) || 0) + 1);
    return timeline;
  }

  // Summary trails the scoreboard → append the current score at current progress.
  if (last.home !== homeNow || last.away !== awayNow) {
    rebuilt.push({
      t: Date.now(), home: homeNow, away: awayNow,
      progress: Math.max(last.progress, game.progress ?? last.progress),
      live: game.live, done: game.done,
    });
  }
  const end = rebuilt[rebuilt.length - 1];
  end.live = game.live;
  end.done = game.done;

  await setCache(`timeline:${game.id}`, rebuilt, CACHE_TTL.timeline);
  _attempts.delete(game.id);
  console.log(`[backfill] ${game.sport} ${game.id}: rebuilt timeline (${rebuilt.length} snapshots, was ${timeline?.length ?? 0})`);
  return rebuilt;
}
