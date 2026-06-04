// ── Sport configurations ──────────────────────────────────────────────────────
export const SPORTS = {
  nba: {
    name: 'NBA', emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'nba',
    margins: { great: 3, good: 8, ok: 15, blowout: 30 },
  },
  nhl: {
    name: 'NHL', emoji: '🏒',
    espnSport: 'hockey', espnLeague: 'nhl',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
  },
  mlb: {
    name: 'MLB', emoji: '⚾',
    espnSport: 'baseball', espnLeague: 'mlb',
    margins: { great: 1, good: 2, ok: 4, blowout: 7 },
  },
  nfl: {
    name: 'NFL', emoji: '🏈',
    espnSport: 'football', espnLeague: 'nfl',
    margins: { great: 3, good: 7, ok: 14, blowout: 24 },
  },
  cfb: {
    name: 'College FB', emoji: '🏈',
    espnSport: 'football', espnLeague: 'college-football',
    margins: { great: 3, good: 7, ok: 14, blowout: 24 },
    // College leagues have hundreds of teams across divisions. `conference`
    // opts a league into: (1) limiting games to one division via the scoreboard
    // `groups` id, and (2) grouping the Teams browser by conference using the
    // standings `level`. group 80 = FBS; standings level 3 = FBS conferences.
    conference: { group: 80, level: 3 },
  },
  cbb: {
    name: 'College BB', emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'mens-college-basketball',
    margins: { great: 3, good: 8, ok: 15, blowout: 30 },
    // group 50 = NCAA Division I; standings level 2 = D-I conferences.
    conference: { group: 50, level: 2 },
  },
  mls: {
    name: 'MLS', emoji: '⚽',
    espnSport: 'soccer', espnLeague: 'usa.1',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    canDraw: true,
  },
  epl: {
    name: 'EPL', emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    espnSport: 'soccer', espnLeague: 'eng.1',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    canDraw: true,
  },
  ucl: {
    name: 'Champions League', emoji: '⭐',
    espnSport: 'soccer', espnLeague: 'uefa.champions',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    canDraw: true,
  },
  wnba: {
    name: 'WNBA', emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'wnba',
    margins: { great: 3, good: 8, ok: 15, blowout: 30 },
  },
  nwsl: {
    name: 'NWSL', emoji: '⚽',
    espnSport: 'soccer', espnLeague: 'usa.nwsl',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    canDraw: true,
  },
  wcbb: {
    name: "Women's College BB", emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'womens-college-basketball',
    margins: { great: 3, good: 8, ok: 15, blowout: 30 },
    // group 50 = NCAA Division I; standings level 2 = D-I conferences.
    conference: { group: 50, level: 2 },
  },
  intl: {
    name: "Int'l Friendly", emoji: '🌍',
    espnSport: 'soccer', espnLeague: 'fifa.friendly',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    canDraw: true,
  },
};

// ── Soccer leagues ────────────────────────────────────────────────────────────
// Single source of truth for "is this sport soccer?". Explicit hardcoded list,
// NOT derived from canDraw — a future non-soccer sport could allow draws (e.g. a
// regular-season tie) without being soccer. When adding a new soccer league to
// SPORTS above, add its key here too so every soccer-specific code path (OT
// detection, progress estimation, thresholds) picks it up.
export const SOCCER_SPORTS = new Set(['mls', 'epl', 'ucl', 'nwsl', 'intl']);

export function isSoccer(sportKey) {
  return SOCCER_SPORTS.has(sportKey);
}

// ── ESPN gamecast/match link ──────────────────────────────────────────────────
// Single source of truth for the "cast ↗" link. Derived entirely from the SPORTS
// config so adding a league here makes its link work everywhere — no client change.
// ESPN's web path equals espnLeague for every non-soccer league (nba, nfl,
// college-football, mens-college-basketball, …); soccer always lives under
// /soccer/match/. Returns null when the sport is unknown or the id is missing.
export function espnGamecastUrl(sportKey, id) {
  const cfg = SPORTS[sportKey];
  if (!cfg || !id) return null;
  if (cfg.espnSport === 'soccer') return `https://www.espn.com/soccer/match/_/gameId/${id}`;
  return `https://www.espn.com/${cfg.espnLeague}/game/_/gameId/${id}`;
}

// ── Cache TTLs (seconds) ──────────────────────────────────────────────────────
export const CACHE_TTL = {
  liveGames:     180,    // 3 min — live games
  finishedGames: 600,    // 10 min — finished games
  probabilities:  7 * 24 * 3600, // 7 days — WP timeline, mirrors score timeline
  frozenOdds:     7 * 24 * 3600, // 7 days — pre-game line, fetched once
  audit:          3 * 24 * 3600, // 3 days — algorithm audit log
  stats:          7 * 24 * 3600, // 7 days — team/goalie stats snapshots
  statsBonus:     7 * 24 * 3600, // 7 days — stats-activity bonus per game
  approxStats:    7 * 24 * 3600, // 7 days — fuzzed combined totals (finished games)
  timeline:       7 * 24 * 3600, // 7 days — per-score-change timeline
  history:        7 * 24 * 3600, // 7 days — per-finished-game history row
};

// ── Win-probability sliding-window lengths (per sport) ────────────────────────
// Drama signal = "the game flipped within this window". Window length adapts
// to each sport's natural drama cadence so a 25% threshold means the same
// thing across NBA (gradual WP) and MLB (one-swing-can-flip-it).
// Sports where ESPN exposes win probability. The ms values are unused by the
// drama analysis (which now diffs consecutive snapshots directly) but the
// presence of a key gates whether WP tracking runs for that sport at all.
export const WP_WINDOW_MS = {
  nba: 1,
  wnba: 1,
  cbb: 1,
  wcbb: 1,
  nfl: 1,
  cfb: 1,
  mlb: 1,
  nhl: 1,
  // soccer (mls/epl/ucl/nwsl/intl) intentionally absent — ESPN doesn't expose WP for soccer
};

// ── Feature flags ─────────────────────────────────────────────────────────────
// Accept any common "truthy" string so dashboard inputs like "True", "1",
// or "yes" don't silently fail.
function isTruthy(v) {
  if (v == null) return false;
  return ['true', '1', 'yes', 'on', 'y'].includes(String(v).toLowerCase().trim());
}

// Algorithm audit logging — captures every signal the score depends on plus
// the per-bonus breakdown of the final excitement score. Off by default to
// keep DB writes minimal; flip on when actively tuning weights.
export const AUDIT_ENABLED = isTruthy(process.env.AUDIT_ENABLED);

// ── Time window ───────────────────────────────────────────────────────────────
export const HOURS_WINDOW = 120; // show games from last 5 days


