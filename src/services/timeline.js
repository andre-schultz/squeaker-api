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

// Basketball uses a different per-event momentum signal. High-frequency scoring
// makes every-possession ties and lead changes noise, so the only event that
// counts is a "comeback surge" — a team that had been behind by
// BB_SURGE_THRESHOLD+ climbing all the way back to a tie or the lead. It re-arms
// (and can fire again) only after that team falls behind by that margin again.
// Close-for-majority still applies; the lead-change tally does not.
const BASKETBALL = new Set(['nba', 'wnba', 'cbb', 'wcbb']);
const BB_SURGE_THRESHOLD = 7;  // deficit (points) a comeback must erase to score
const BB_SURGE_BASE      = 10; // points per late comeback surge (× lateness weight)
const BB_RUN_THRESHOLD   = 9;  // unanswered points that qualify as a scoring "run"
const BB_RUN_BASE_SCALE  = 0.5; // run bases are half the non-basketball event bases:
                                // a run that fires every other game shouldn't be worth
                                // as much as a single decisive late goal/basket. Tuned
                                // from the historical basketball rescore — at full base
                                // + threshold 7 the bonus saturated momentum's 25-pt cap
                                // in ~40% of NBA games; this keeps it discriminating.
const BB_CLOSE           = 5;  // basketball "close" margin (matches closenessThreshold)

// Per-sport denominator for the comeback bonus — the deficit erased is measured
// relative to this. Defaults to the sport's `margins.good`; overridden here when
// a sport's comeback feel differs from `good` (a 3-run MLB hole and a 10-point
// NFL hole are the unit of a "real" comeback in those sports). Kept separate
// from `margins.good` so tuning comebacks doesn't shift the closeness wording.
const COMEBACK_DENOM = { mlb: 3, nfl: 10, cfb: 10 };

// Analyze timeline to produce momentum scoring signals.
// `opts.done` / `opts.progress` describe the game as a whole (not the last
// snapshot) so the whole-game closeness fraction can extend to the true end of
// the game — the final margin holds from the last scoring play to the whistle.
export function analyzeMomentum(timeline, sport, opts = {}) {
  if (!timeline || timeline.length < 2) {
    return { momentumBonus: 0, signals: [], breakdown: {} };
  }

  const signals  = [];
  let bonus      = 0;
  // Per-component sub-totals (pre-cap), exposed in the returned breakdown for
  // audit/analysis. They sum to `bonus` before the 25-pt clamp.
  let surgeBonus      = 0; // basketball comeback surge
  let eventBonus      = 0; // non-basketball per-scoring-event bonuses
  let leadChangeBonus = 0; // non-basketball whole-game multiple-lead-change bonus

  const sportKey     = sport?.sport || sport;
  const isBasketball = BASKETBALL.has(sportKey);
  const closeThresh  = closenessThreshold(sport);

  const first    = timeline[0];
  const last     = timeline[timeline.length - 1];
  const duration = last.t - first.t; // wall-clock span; only a progress fallback now

  let leadChanges = 0;
  let prevLeader  = getLeader(first.home, first.away);

  // Basketball comeback-surge state: a team is "armed" once it has been behind
  // by BB_SURGE_THRESHOLD+, and fires when it climbs back to a tie or the lead
  // (then must fall behind by that margin again to re-arm).
  let homeArmed = false, awayArmed = false;
  if (isBasketball) {
    const d0 = first.home - first.away;
    if (d0 <= -BB_SURGE_THRESHOLD) homeArmed = true;
    if (d0 >=  BB_SURGE_THRESHOLD) awayArmed = true;
  }

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

    if (isBasketball) {
      // Comeback surge: a team that had been behind by 5+ climbs back to a tie
      // or the lead. Scored once per surge, weighted by lateness; re-arms only
      // after the team falls behind by 5+ again. Both directions are tracked
      // independently, so a game that swings back the other way fires again.
      const d = curr.home - curr.away;
      if (d <= -BB_SURGE_THRESHOLD) homeArmed = true;
      if (d >=  BB_SURGE_THRESHOLD) awayArmed = true;
      if (d >= 0 && homeArmed) {
        if (w > 0) { signals.push('Late comeback to tie/lead'); surgeBonus += BB_SURGE_BASE * w; }
        homeArmed = false;
      } else if (d <= 0 && awayArmed) {
        if (w > 0) { signals.push('Late comeback to tie/lead'); surgeBonus += BB_SURGE_BASE * w; }
        awayArmed = false;
      }
    } else {
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
          eventBonus += base * w;
        }
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
  }

  // Multiple lead changes over the whole game (downgraded from 6/3 to 4/2).
  // Skipped for basketball, where frequent lead changes are noise — the
  // comeback-surge and run events are basketball's per-event signals instead.
  if (!isBasketball) {
    if (leadChanges >= 3) {
      signals.push(`${leadChanges} lead changes`);
      leadChangeBonus = 4;
    } else if (leadChanges >= 2) {
      signals.push(`${leadChanges} lead changes`);
      leadChangeBonus = 2;
    }
  } else if (opts.runBonus > 0) {
    // Basketball scoring runs, pre-computed from play-by-play in the stats cycle
    // (analyzeBasketballRuns) and passed through here so they share momentum's
    // 25-pt cap with the surge and close-time bonuses.
    for (const s of opts.runSignals || []) signals.push(s);
  }

  // Sum the sub-totals; the run bonus only applies to basketball.
  const runsBonus = isBasketball ? (opts.runBonus || 0) : 0;
  bonus = surgeBonus + eventBonus + leadChangeBonus + closeBonus + runsBonus;

  // Per-component breakdown (pre-cap) for audit/analysis. Cap momentum at 25,
  // then round (event bonuses are fractional).
  const breakdown = isBasketball
    ? { surge: surgeBonus, runs: runsBonus, close: closeBonus }
    : { events: eventBonus, leadChanges: leadChangeBonus, close: closeBonus };

  return { momentumBonus: Math.round(Math.min(bonus, 25)), signals, breakdown };
}

// ── Comeback bonus (0–15) ─────────────────────────────────────────────────────
// Trajectory-aware, unlike the old halftime-vs-final check. Tracks the largest
// deficit each team has faced since it was last tied-or-ahead. The instant a
// team that had fallen behind climbs back to a tie or the lead, that's a
// completed comeback and it scores:
//
//     (deficitErased / denom) × progressAtCompletion × 10
//
// `denom` is the sport's "meaningful lead" size (see COMEBACK_DENOM), so the
// deficit is measured relative to what counts as a real hole in that sport.
// After firing, the team must fall behind again to re-arm — so a see-saw game
// can fire multiple times. The total is summed and capped at 15. Works for
// every sport (margin-based; no sport-specific branches beyond the denominator).
export function analyzeComeback(timeline, sport, opts = {}) {
  if (!timeline || timeline.length < 2) return { comebackBonus: 0, signals: [] };

  // Basketball already credits comebacks via the momentum comeback-surge signal
  // (which carries its own 7-point noise threshold). Skip here so a basketball
  // rally isn't counted twice.
  if (BASKETBALL.has(opts.sportKey)) return { comebackBonus: 0, signals: [] };

  const denom    = COMEBACK_DENOM[opts.sportKey] ?? sport?.margins?.good ?? 2;
  const signals  = [];
  let bonus      = 0;

  const first    = timeline[0];
  const last     = timeline[timeline.length - 1];
  const duration = last.t - first.t;
  const progOf   = (s) =>
    s.progress != null
      ? s.progress
      : (duration > 0 ? (s.t - first.t) / duration : 0);

  // Worst deficit each team has faced since it was last tied-or-ahead. Seeded
  // from the first snapshot in case the timeline opens mid-deficit.
  let homeDeficit = Math.max(0, first.away - first.home);
  let awayDeficit = Math.max(0, first.home - first.away);

  for (let i = 1; i < timeline.length; i++) {
    const curr = timeline[i];
    const d    = curr.home - curr.away; // + = home leads, − = away leads

    // Grow the running deficit while a side is behind.
    if (d < 0) homeDeficit = Math.max(homeDeficit, -d);
    if (d > 0) awayDeficit = Math.max(awayDeficit,  d);

    // Home completes a comeback: had been behind, now tied or leading.
    if (d >= 0 && homeDeficit > 0) {
      bonus += (homeDeficit / denom) * progOf(curr) * 10;
      signals.push(`Comeback from ${homeDeficit} down`);
      homeDeficit = 0; // re-arm only after falling behind again
    }
    // Away completes a comeback.
    if (d <= 0 && awayDeficit > 0) {
      bonus += (awayDeficit / denom) * progOf(curr) * 10;
      signals.push(`Comeback from ${awayDeficit} down`);
      awayDeficit = 0;
    }
  }

  return { comebackBonus: Math.min(15, Math.round(bonus)), signals };
}

// ── Basketball scoring runs ───────────────────────────────────────────────────
// Basketball's per-event momentum can't ride individual baskets (too noisy) and
// the polled timeline is too coarse to see unanswered runs — so this works off
// the ESPN play-by-play (`plays`) instead, fetched in the stats cycle.
//
// A run is a stretch of UNANSWERED points: it breaks the instant the opponent
// scores (unlike the comeback surge, which tolerates the opponent scoring during
// a rally — the two are intentionally separate signals and both can fire). Each
// completed run of BB_RUN_THRESHOLD+ points is classified by the score before the
// run vs. at its peak — flip / tie / go-ahead-from-tie / keep-close — using the
// same base values as non-basketball scoring events (scaled by BB_RUN_BASE_SCALE),
// then scaled by run size and lateness:
//
//     (runPoints / BB_RUN_THRESHOLD) × progressAtRunEnd × (base × BB_RUN_BASE_SCALE)
//
// e.g. a 10-0 run that flips the lead late ≈ (10/9) × ~1.0 × (10 × 0.5) ≈ 5.6.
// Summed across all runs; the caller folds the total into the (capped) momentum
// bonus. `opts.threshold` / `opts.baseScale` override the defaults for tuning.
export function analyzeBasketballRuns(plays, homeId, awayId, format, opts = {}) {
  const out = { runBonus: 0, signals: [] };
  if (!Array.isArray(plays) || homeId == null || awayId == null) return out;

  // Tunables (defaults preserve production behavior). `threshold` is both the
  // qualifying minimum and the normalizer; `baseScale` scales every flip/tie/
  // go-ahead/close base. Exposed so offline tuning experiments can sweep them.
  const threshold = opts.threshold ?? BB_RUN_THRESHOLD;
  const baseScale = opts.baseScale ?? BB_RUN_BASE_SCALE;

  const regPeriods = format?.regulation?.periods || 4;
  const periodSecs = format?.regulation?.clock    || 720;
  const totalSecs  = regPeriods * periodSecs;

  const scoring = plays.filter(p => p?.scoringPlay &&
    typeof p.homeScore === 'number' && typeof p.awayScore === 'number');
  if (scoring.length < 2) return out;

  // Progress (0–1) of a play from period + clock remaining. Overtime clamps to 1.
  const progOf = (p) => {
    const per = p?.period?.number || 1;
    const rem = clockSeconds(p?.clock);
    const elapsed = (Math.min(per, regPeriods) - 1) * periodSecs + (periodSecs - rem);
    return Math.max(0, Math.min(1, elapsed / totalSecs));
  };

  let prevH = 0, prevA = 0;          // running score, before the current play
  let runner = null;                 // 'home' | 'away' currently on the run
  let runPts = 0;                    // unanswered points in the active run
  let beforeH = 0, beforeA = 0;      // score the instant the active run began

  // Score the run that just ended at peak (peakH, peakA); endPlay times it.
  const flush = (peakH, peakA, endPlay) => {
    if (!runner || runPts < threshold) return;
    const base = classifyRun(beforeH, beforeA, peakH, peakA) * baseScale;
    if (base <= 0) return;
    out.runBonus += (runPts / threshold) * progOf(endPlay) * base;
    out.signals.push(`${runPts}-0 run`);
  };

  for (const p of scoring) {
    const dH = p.homeScore - prevH;
    const dA = p.awayScore - prevA;
    const scorer = dH > 0 ? 'home' : (dA > 0 ? 'away' : null);
    if (scorer === null) { prevH = p.homeScore; prevA = p.awayScore; continue; }
    const pts = scorer === 'home' ? dH : dA;

    if (scorer === runner) {
      runPts += pts;                 // run continues
    } else {
      flush(prevH, prevA, p);        // opponent scored → previous run ended at peak
      runner  = scorer;
      runPts  = pts;
      beforeH = prevH; beforeA = prevA;
    }
    prevH = p.homeScore; prevA = p.awayScore;
  }
  // A run still active at the final buzzer (opponent never answered) counts too.
  flush(prevH, prevA, scoring[scoring.length - 1]);

  out.runBonus = Math.round(out.runBonus);
  return out;
}

// Classify a run by the score before it began vs. at its peak. Mirrors the
// non-basketball event priority: lead flip (10) > equalizer (8) > go-ahead from
// a tie (7) > a run that (still) leaves the game close (4). 0 = no momentum swing
// (e.g. a run that only extends an already-comfortable lead).
function classifyRun(beforeH, beforeA, peakH, peakA) {
  const before = getLeader(beforeH, beforeA);
  const after  = getLeader(peakH, peakA);
  const margin = Math.abs(peakH - peakA);
  if (before !== 'tied' && after !== 'tied' && before !== after) return 10; // flip
  if (margin === 0)                                              return 8;  // equalizer
  if (before === 'tied' && after !== 'tied')                     return 7;  // go-ahead from tie
  if (margin <= BB_CLOSE)                                        return 4;  // kept close
  return 0;
}

// Seconds remaining from an ESPN clock object ("10:42" → 642, "6.8" → 6.8).
function clockSeconds(clock) {
  const s = clock?.displayValue;
  if (!s) return 0;
  if (s.includes(':')) {
    const [m, sec] = s.split(':').map(Number);
    return (m || 0) * 60 + (sec || 0);
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
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
    mls: 1, epl: 1, ucl: 1, nwsl: 1, intl: 1, wc: 1, cfb: 7, cbb: 5, wcbb: 5,
  };
  // Soccer leagues not explicitly listed are decided by a single goal.
  return thresholds[key] ?? (isSoccer(key) ? 1 : 2);
}
