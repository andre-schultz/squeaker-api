// ── Excitement Score (0-100) ──────────────────────────────────────────────────
// Closeness:        0-65 pts  (dominant factor; maxed automatically when isOT)
//                             Soccer: max 60, flat for margin 0–1, linear below.
//                             Other sports: max 65 at margin=1, linear below.
//                             The margin passed in is "scoring margin" — empty-net
//                             goals are stripped upstream so garbage-time ENGs
//                             don't inflate the gap (see espn.js).
// Comeback:         0-15 pts  (scaled by deficit erased × progress; can fire
//                             multiple times, summed and capped — see analyzeComeback)
// OT:                 +5 pts
// Shootout:           +5 pts  (penalty shootout / hockey SO — stacked on top of
//                             the OT bonus; a shootout ending is more dramatic
//                             than an ordinary OT/ET winner)
// Momentum bonus:    +25 pts  (late goals, lead changes, time spent close)
// Upset bonus:       +10 pts  (underdog won outright)
// Stats activity:   +20 pts  (computed from game stats snapshot; extra-high
//                             stats above the p90 ceiling can push past 15)
//
// Theoretical raw max if all bonuses fire: 145. Clamped to 100 at the end.
// Bonuses are independent — each contributes its full value if earned.
// WP-drama is tracked separately as part of the Action score, not here.

// Both entry points take a single options object:
//   { margin, sport, isOT, isShootout, comebackBonus, momentumBonus,
//     progress, upsetBonus, statsBonus }
// `margin` and `sport` (a SPORTS config entry) are required; everything else
// defaults to "no bonus" / full progress.
export function calcExcitement(opts) {
  return calcExcitementBreakdown(opts).final;
}

// Returns the per-bonus breakdown used for the audit log. The `final` field is
// the same value calcExcitement returns; the rest expose the intermediate
// values for the audit snapshot.
//
// For live games the raw score is scaled by how far through the game we are:
// a 0-0 tie in the 1st inning scores much lower than 0-0 in the 9th. Early
// game blends 30% raw + 70% progress-weighted; the final 20% applies full raw.
export function calcExcitementBreakdown({
  margin,
  sport,
  isOT = false,
  isShootout = false,
  comebackBonus = 0,
  momentumBonus = 0,
  progress = 1.0,
  upsetBonus = 0,
  statsBonus = 0,
}) {
  const cls = closenessScore(margin, sport, isOT);
  const otBonus = isOT ? 5 : 0;
  // A shootout (soccer penalties / hockey SO) is a distinct, higher-drama ending
  // than an ordinary OT/ET win, so it earns an extra +5 stacked on top of the OT
  // bonus. isShootout implies isOT upstream, so a shootout game earns both.
  const shootoutBonus = isShootout ? 5 : 0;
  // Comeback bonus is computed and capped upstream (analyzeComeback); clamp
  // again defensively so the breakdown can never exceed its 15-pt ceiling.
  const cb = Math.min(15, comebackBonus || 0);
  const raw =
    cls +
    otBonus +
    shootoutBonus +
    cb +
    momentumBonus +
    upsetBonus +
    statsBonus;

  const progressMultiplier = progress < 0.8 ? 0.3 + (progress / 0.8) * 0.7 : 1.0;

  return {
    closeness:  cls,
    ot:         otBonus,
    shootout:   shootoutBonus,
    comeback:   cb,
    momentum:   momentumBonus,
    upset:      upsetBonus,
    stats:      statsBonus,
    raw,
    progressMultiplier,
    final:      Math.min(100, Math.round(raw * progressMultiplier)),
  };
}

// Closeness — linear scale from max down to 0 at the sport's blowout threshold.
// Soccer (canDraw): max is 60; a draw and a 1-goal win both earn the max.
//   Scale anchors at margin=1 (÷ blowout−1) so steps are equal from there down.
// Non-soccer: max is 65, also anchored at margin=1.
// OT/extra-innings games are always max closeness — teams were tied at end of regulation.
function closenessScore(margin, sport, isOT = false) {
  const maxClose = sport.canDraw ? 60 : 65;
  const blowout  = sport.margins.blowout;
  if (isOT || margin === 0) return maxClose;
  if (margin >= blowout) return 0;
  return Math.ceil(maxClose * (blowout - margin) / (blowout - 1));
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
