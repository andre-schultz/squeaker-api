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
// Live game:     velocity 60% + comments 25% + upvotes 15%
// Finished game: comments 60% + upvotes 40%
// Normalized against sport baseline so MLS isn't unfairly vs NBA

export function calcBuzz({ comments, upvotes, velocity, isLive }, sport) {
  const base = sport.base;

  const commentScore  = normalize(comments,  base.comments);
  const upvoteScore   = normalize(upvotes,   base.upvotes);
  const velocityScore = normalize(velocity,  base.velocity);

  if (isLive) {
    return Math.round(
      velocityScore * 0.60 +
      commentScore  * 0.25 +
      upvoteScore   * 0.15
    );
  } else {
    return Math.round(
      commentScore * 0.60 +
      upvoteScore  * 0.40
    );
  }
}

function normalize(value, baseline) {
  return Math.min(100, Math.round((value / baseline) * 100));
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
