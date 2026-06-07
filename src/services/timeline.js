import { getCache, setCache } from './cache.js';
import { CACHE_TTL, isSoccer } from '../config.js';

const TIMELINE_TTL = CACHE_TTL.timeline;

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
    t:        Date.now(),       // timestamp
    home:     homeScore,
    away:     awayScore,
    progress: game.progress ?? null,
    live:     game.live,
    done:     game.done,
  };

  const updated = [...existing, snapshot];
  await setCache(key, updated, TIMELINE_TTL);
  return updated;
}

// Load the full timeline for a game
export async function getTimeline(gameId) {
  return await getCache(`timeline:${gameId}`) || [];
}

// Linear "lateness" weight for a scoring event, based on how far into the game
// it happened. Zero at (or before) the midpoint, ramping linearly to 1.0 at the
// final whistle. This replaces the old binary late-threshold cliff: a goal in
// the 70th minute now counts almost as much as one in the 89th, and one at the
// hour mark still earns partial credit instead of nothing.
//   progress 0.50 → 0.0
//   progress 0.75 → 0.5
//   progress 1.00 → 1.0
function lateWeight(progress) {
  if (progress == null) return null; // caller substitutes a time-based fallback
  return Math.max(0, Math.min(1, (progress - 0.5) / 0.5));
}

// Analyze timeline to produce momentum scoring signals.
// `opts.done` / `opts.progress` describe the game as a whole (not the last
// snapshot) so the whole-game closeness fraction can extend to the true end of
// the game — the final margin holds from the last scoring play to the whistle.
export function analyzeMomentum(timeline, sport, opts = {}) {
  if (!timeline || timeline.length < 2) {
    return { momentumBonus: 0, signals: [] };
  }

  const signals  = [];
  let bonus      = 0;

  const closeThresh = closenessThreshold(sport);

  const first    = timeline[0];
  const last     = timeline[timeline.length - 1];
  const duration = last.t - first.t; // wall-clock span; only a progress fallback now

  let leadChanges = 0;
  let prevLeader  = getLeader(first.home, first.away);

  // Progress (0–1) for a snapshot, falling back to its elapsed-time fraction for
  // old snapshots written before `progress` was added to the schema.
  const progOf = (s) =>
    s.progress != null
      ? s.progress
      : (duration > 0 ? (s.t - first.t) / duration : 0);

  // Fraction of the WHOLE game spent close / tied, measured with progress as the
  // clock. A snapshot's margin holds from its progress until the next snapshot
  // (the score only changes at snapshots); the final margin is carried to the
  // end of regulation below for finished games. Because it's a running fraction
  // of the full game it ramps up as the game stays close, and is comparable
  // across sports.
  let closeFrac = 0;

  for (let i = 1; i < timeline.length; i++) {
    const prev    = timeline[i - 1];
    const curr    = timeline[i];
    const margin  = Math.abs(curr.home - curr.away);
    const leader  = getLeader(curr.home, curr.away);

    // The previous score held for the span between the two snapshots.
    const span       = Math.max(0, progOf(curr) - progOf(prev));
    const prevMargin = Math.abs(prev.home - prev.away);
    if (prevMargin <= closeThresh) closeFrac += span;

    // How much this event counts toward the late-drama bonuses, ramped linearly
    // from the midpoint to the final whistle.
    const w = lateWeight(progOf(curr));

    // A lead change is itself the go-ahead score, so it's scored once below
    // rather than paid separately. We still *count* it here for the
    // multiple-lead-changes whole-game bonus.
    const isLeadChange = leader !== 'tied' && prevLeader !== 'tied' && leader !== prevLeader;
    if (isLeadChange) leadChanges++;

    // One bonus per scoring event, chosen by its most significant effect and
    // scaled by how late it happened (w). Priority: a lead flips hands >
    // equalizer > taking the lead from a tie > a goal that keeps it close.
    const scored = (curr.home + curr.away) > (prev.home + prev.away);
    if (scored && w > 0) {
      let base = 0, label = '';
      if (isLeadChange)               { base = 10; label = 'Late lead change'; }
      else if (margin === 0)          { base = 8;  label = 'Late equalizer'; }
      else if (leader !== prevLeader) { base = 7;  label = 'Late go-ahead goal'; } // took lead from a tie
      else if (margin <= closeThresh) { base = 4;  label = 'Late goal in close game'; }
      if (base > 0) {
        signals.push(label);
        bonus += base * w;
      }
    }

    prevLeader = leader !== 'tied' ? leader : prevLeader;
  }

  // Carry the final score from the last snapshot to the end of the game: a
  // finished game runs to 1.0, a live game to its current progress. The score
  // only changes at snapshots, so the last margin held over this whole gap.
  const endProg    = opts.done ? 1.0 : Math.max(progOf(last), opts.progress ?? progOf(last));
  const tailSpan   = Math.max(0, endProg - progOf(last));
  const lastMargin = Math.abs(last.home - last.away);
  if (lastMargin <= closeThresh) closeFrac += tailSpan;

  // Whole-game closeness: linear in the fraction of the game spent close,
  // scaled to a max of 10 (close wire-to-wire ⇒ 10). Time spent exactly tied is
  // a subset of close time, so a tie-heavy game is already rewarded here.
  const closeBonus = Math.min(10, closeFrac * 10);
  if (closeBonus > 0) {
    signals.push(`Game stayed close (${Math.round(closeBonus)}/10)`);
    bonus += closeBonus;
  }

  // Multiple lead changes over the whole game (downgraded from 6/3 to 4/2).
  if (leadChanges >= 3) {
    signals.push(`${leadChanges} lead changes`);
    bonus += 4;
  } else if (leadChanges >= 2) {
    signals.push(`${leadChanges} lead changes`);
    bonus += 2;
  }

  // Cap momentum bonus at 25, then round (event bonuses are now fractional).
  return { momentumBonus: Math.round(Math.min(bonus, 25)), signals };
}

function getLeader(home, away) {
  if (home > away) return 'home';
  if (away > home) return 'away';
  return 'tied';
}

// Sport-specific "close" threshold (within this many points = close)
function closenessThreshold(sport) {
  const key = sport?.sport || sport;
  const thresholds = {
    nba: 5, wnba: 5, nfl: 7, mlb: 1, nhl: 1,
    mls: 1, epl: 1, ucl: 1, nwsl: 1, intl: 1, cfb: 7, cbb: 5, wcbb: 5,
  };
  // Soccer leagues not explicitly listed are decided by a single goal.
  return thresholds[key] ?? (isSoccer(key) ? 1 : 2);
}
