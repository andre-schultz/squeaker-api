// ── Excitement Score (0-100) ──────────────────────────────────────────────────
// Closeness:        0-70 pts  (dominant factor)
// Comeback:          +10 pts
// OT:                +10 pts
// Momentum bonus:    +20 pts  (late goals, lead changes, time spent close)
// WP-drama bonus:    +15 pts  (sport-windowed win-prob swings, late comebacks)
// Upset bonus:       +10 pts  (underdog won outright)
//
// Theoretical raw max if all bonuses fire: 135. Clamped to 100 at the end.
// Bonuses are independent — each contributes its full value if earned.

export function calcExcitement(
  margin,
  isOT,
  isComeback,
  sport,
  momentumBonus = 0,
  progress = 1.0,
  wpDramaBonus = 0,
  upsetBonus = 0,
) {
  const cls = closenessScore(margin, sport.margins);
  const otBonus       = isOT       ? 10 : 0;
  const comebackBonus = isComeback ? 10 : 0;
  const raw =
    cls +
    otBonus +
    comebackBonus +
    momentumBonus +
    wpDramaBonus +
    upsetBonus;

  // For live games, scale score by how far through the game we are.
  // A 0-0 tie in the 1st inning scores much lower than 0-0 in the 9th.
  // We blend: early game gets 30% raw + 70% progress-weighted.
  // By the final 20% of the game, the full raw score applies.
  const progressMultiplier = progress < 0.8
    ? 0.3 + (progress / 0.8) * 0.7   // ramps from 0.3→1.0 over first 80%
    : 1.0;                             // last 20% = full score

  return Math.min(100, Math.round(raw * progressMultiplier));
}

// Returns the per-bonus breakdown used for the audit log. Same logic as
// calcExcitement but exposes intermediate values rather than the rounded
// total. Use this when recording audit snapshots.
export function calcExcitementBreakdown(
  margin,
  isOT,
  isComeback,
  sport,
  momentumBonus = 0,
  progress = 1.0,
  wpDramaBonus = 0,
  upsetBonus = 0,
) {
  const cls = closenessScore(margin, sport.margins);
  const otBonus       = isOT       ? 10 : 0;
  const comebackBonus = isComeback ? 10 : 0;
  const raw =
    cls +
    otBonus +
    comebackBonus +
    momentumBonus +
    wpDramaBonus +
    upsetBonus;

  const progressMultiplier = progress < 0.8 ? 0.3 + (progress / 0.8) * 0.7 : 1.0;

  return {
    closeness:  cls,
    ot:         otBonus,
    comeback:   comebackBonus,
    momentum:   momentumBonus,
    wp:         wpDramaBonus,
    upset:      upsetBonus,
    raw,
    progressMultiplier,
    final:      Math.min(100, Math.round(raw * progressMultiplier)),
  };
}

// Closeness — proportionally rescaled from old 90/72/46/16/0 to fit a
// 0-70 ceiling, preserving the relative gap between tiers.
function closenessScore(margin, m) {
  if (margin <= m.great)   return 70;
  if (margin <= m.good)    return 56;
  if (margin <= m.ok)      return 36;
  if (margin <= m.blowout) return 12;
  return 0;
}

// Comeback: did the margin shrink significantly from halftime to final?
// Doesn't require the trailing team to win — narrowing counts too.
export function detectComeback(halfHome, halfAway, finalMargin, sport) {
  if (halfHome == null || halfAway == null) return false;
  const halfMargin = Math.abs(halfHome - halfAway);
  return (halfMargin - finalMargin) >= sport.margins.good;
}

// ── Buzz Score (0-100) ───────────────────────────────────────────────────────
// Live game:     velocity 40% + sentiment 60%
// Finished game: sentiment 100%  (velocity noise fades, language stays rich)
// Normalized against sport baseline so MLS isn't unfairly vs NBA

export function calcBuzz({ comments, upvotes, velocity, sentiment, isLive }, sport) {
  const base = sport.base;

  // Normalize each signal 0-100 against sport baseline
  const commentScore  = normalize(comments,  base.comments);
  const upvoteScore   = normalize(upvotes,   base.upvotes);
  const velocityScore = normalize(velocity,  base.velocity);

  // sentiment arrives as 0-100 from reddit service

  if (isLive) {
    // Live: weight velocity heavily, sentiment matters
    return Math.round(
      velocityScore * 0.40 +
      sentiment     * 0.35 +
      commentScore  * 0.15 +
      upvoteScore   * 0.10
    );
  } else {
    // Finished: pure sentiment + volume, velocity ignored
    return Math.round(
      sentiment    * 0.50 +
      commentScore * 0.30 +
      upvoteScore  * 0.20
    );
  }
}

function normalize(value, baseline) {
  return Math.min(100, Math.round((value / baseline) * 100));
}

// ── Chatter Score (0-100) ────────────────────────────────────────────────────
// Bluesky-only. Measures recent fold-increase in posts-per-minute relative to
// a rolling baseline (mean of the last 5 ppm readings, or all available if
// fewer). 10x baseline saturates the scale:
//   score = min(100, round((currentPpm / floor) * 10))
// So 1x → 10, 5x → 50, 10x → 100. Captures "chatter has picked up recently"
// rather than absolute volume.
//
// Edge case: floor === 0 (no history yet, or 5 cycles of dead silence) →
// score 0. A genuine burst out of a dry spell registers next cycle once it's
// in history; keeps the score honest when there's no baseline to compare to.
export function calcChatterPpm(ppm, floor) {
  if (floor === 0) return 0;
  return Math.min(100, Math.round((ppm / floor) * 10));
}

// ── Labels ───────────────────────────────────────────────────────────────────
export function excitementLabel(score) {
  if (score >= 80) return 'Must Watch';
  if (score >= 60) return 'Exciting';
  if (score >= 40) return 'Worth It';
  if (score >= 20) return 'So-So';
  return 'Skip It';
}

export function excitementDesc(margin, isOT, isComeback, sport) {
  const m = sport.margins;
  if (isOT && isComeback)       return 'Team battled back and forced overtime';
  if (isOT)                     return 'Decided in overtime';
  if (isComeback && margin<=m.good) return 'Comeback in a tightly-fought game';
  if (isComeback)               return 'One team rallied back from a deficit';
  if (margin <= m.great)        return 'Razor-thin — as close as it gets';
  if (margin <= m.good)         return 'Very competitive, decided very late';
  if (margin <= m.ok)           return 'Some separation, but not a blowout';
  if (margin <= m.blowout)      return 'One team pulled clear in the end';
  return 'Dominant — one-sided from the start';
}
