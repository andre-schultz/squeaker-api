// ── Excitement Score (0-100) ──────────────────────────────────────────────────
// Closeness: 0-90 pts  (dominant factor)
// Comeback:   +10 pts  (margin narrowed significantly from half to final)
// OT:         +10 pts  (went to overtime / extra time)
// Capped at 100

export function calcExcitement(margin, isOT, isComeback, sport) {
  const cls = closenessScore(margin, sport.margins);
  const raw = cls + (isComeback ? 10 : 0) + (isOT ? 10 : 0);
  return Math.min(100, raw);
}

function closenessScore(margin, m) {
  if (margin <= m.great)   return 90;
  if (margin <= m.good)    return 72;
  if (margin <= m.ok)      return 46;
  if (margin <= m.blowout) return 16;
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
