// ── Sport configurations ──────────────────────────────────────────────────────
// Per-sport tuning fields (beyond the identity/ESPN routing ones):
//   margins      — closeness tiers for scoring + wording (see algorithm.js)
//   closeMargin  — "the game is close" threshold for momentum's close-time
//                  bonus (timeline.js). Kept separate from margins.great so
//                  closeness wording and momentum tuning move independently.
//   comebackDenom — optional; the deficit that counts as a "real" hole for the
//                  comeback bonus. Defaults to margins.good (timeline.js).
//   action       — optional; per-play WP-swing multipliers for the action score
//                  (probabilities.js). Present ⟺ ESPN exposes win probability
//                  for the sport, so it also gates WP tracking (see WP_SPORTS).
export const SPORTS = {
  nba: {
    name: 'NBA', emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'nba',
    margins: { great: 3, good: 8, ok: 15, blowout: 30 },
    closeMargin: 5,
    action: { avgSwing: 1200, consecRate: 90, semiRate: 60 },
  },
  nhl: {
    name: 'NHL', emoji: '🏒',
    espnSport: 'hockey', espnLeague: 'nhl',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    closeMargin: 1,
    action: { avgSwing: 1100, consecRate: 85, semiRate: 55 },
  },
  mlb: {
    name: 'MLB', emoji: '⚾',
    espnSport: 'baseball', espnLeague: 'mlb',
    margins: { great: 1, good: 2, ok: 4, blowout: 7 },
    closeMargin: 1,
    comebackDenom: 3,
    action: { avgSwing: 800, consecRate: 60, semiRate: 40 },
  },
  nfl: {
    name: 'NFL', emoji: '🏈',
    espnSport: 'football', espnLeague: 'nfl',
    margins: { great: 3, good: 7, ok: 14, blowout: 24 },
    closeMargin: 7,
    comebackDenom: 10,
    action: { avgSwing: 1400, consecRate: 110, semiRate: 70 },
  },
  cfb: {
    name: 'College FB', emoji: '🏈',
    espnSport: 'football', espnLeague: 'college-football',
    margins: { great: 3, good: 7, ok: 14, blowout: 24 },
    closeMargin: 7,
    comebackDenom: 10,
    action: { avgSwing: 1300, consecRate: 100, semiRate: 65 },
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
    closeMargin: 5,
    // CBB/WCBB intentionally skew low — most games are mismatches — but
    // competitive games still reach the high end.
    action: { avgSwing: 1600, consecRate: 120, semiRate: 80 },
    // group 50 = NCAA Division I; standings level 2 = D-I conferences.
    conference: { group: 50, level: 2 },
  },
  mls: {
    name: 'MLS', emoji: '⚽',
    espnSport: 'soccer', espnLeague: 'usa.1',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    closeMargin: 1,
    canDraw: true,
  },
  epl: {
    name: 'EPL', emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    espnSport: 'soccer', espnLeague: 'eng.1',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    closeMargin: 1,
    canDraw: true,
  },
  ucl: {
    name: 'Champions League', emoji: '⭐',
    espnSport: 'soccer', espnLeague: 'uefa.champions',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    closeMargin: 1,
    canDraw: true,
  },
  wnba: {
    name: 'WNBA', emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'wnba',
    margins: { great: 3, good: 8, ok: 15, blowout: 30 },
    closeMargin: 5,
    action: { avgSwing: 1200, consecRate: 90, semiRate: 60 },
  },
  nwsl: {
    name: 'NWSL', emoji: '⚽',
    espnSport: 'soccer', espnLeague: 'usa.nwsl',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    closeMargin: 1,
    canDraw: true,
  },
  wcbb: {
    name: "Women's College BB", emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'womens-college-basketball',
    margins: { great: 3, good: 8, ok: 15, blowout: 30 },
    closeMargin: 5,
    action: { avgSwing: 1600, consecRate: 120, semiRate: 80 },
    // group 50 = NCAA Division I; standings level 2 = D-I conferences.
    conference: { group: 50, level: 2 },
  },
  intl: {
    name: "Int'l Friendly", emoji: '🌍',
    espnSport: 'soccer', espnLeague: 'fifa.friendly',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    closeMargin: 1,
    canDraw: true,
  },
  wc: {
    name: 'World Cup', emoji: '🏆',
    espnSport: 'soccer', espnLeague: 'fifa.world',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    closeMargin: 1,
    canDraw: true,
  },
};

// ── Soccer leagues ────────────────────────────────────────────────────────────
// Single source of truth for "is this sport soccer?". Explicit hardcoded list,
// NOT derived from canDraw — a future non-soccer sport could allow draws (e.g. a
// regular-season tie) without being soccer. When adding a new soccer league to
// SPORTS above, add its key here too so every soccer-specific code path (OT
// detection, progress estimation, thresholds) picks it up.
export const SOCCER_SPORTS = new Set(['mls', 'epl', 'ucl', 'nwsl', 'intl', 'wc']);

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
// games:all / games:upcoming are overwritten by the warmup cycle every 3–10
// minutes; their TTL is only a safety net that clears data if the cycle dies.
// It must comfortably exceed the longest refresh interval (10 min off-hours) —
// when the two were equal, any slow/failed cycle left the cache empty and every
// request fell back to a full ESPN fan-out.
export const CACHE_TTL = {
  liveGames:     1800,   // 30 min — games:all when live games exist
  finishedGames: 1800,   // 30 min — games:all (no live) and games:upcoming
  probabilities:  7 * 24 * 3600, // 7 days — WP timeline, mirrors score timeline
  frozenOdds:     7 * 24 * 3600, // 7 days — pre-game line, fetched once
  audit:          3 * 24 * 3600, // 3 days — algorithm audit log
  stats:          7 * 24 * 3600, // 7 days — team/goalie stats snapshots
  statsBonus:     7 * 24 * 3600, // 7 days — stats-activity bonus per game
  approxStats:    7 * 24 * 3600, // 7 days — fuzzed combined totals (finished games)
  timeline:       7 * 24 * 3600, // 7 days — per-score-change timeline
  history:        7 * 24 * 3600, // 7 days — per-finished-game history row
  // Per-day game shards are only rewritten when that day's contents change, so
  // unlike games:all they can sit untouched for the life of the window. The TTL
  // has to outlive HOURS_WINDOW or a quiet past day would silently expire.
  dayShard:      13 * 24 * 3600, // 13 days — one day's games (games:day:YYYY-MM-DD)
  // Matches dayShard deliberately. The index is rewritten every cycle, so a
  // short TTL would cost nothing in the happy path — but if the cycle dies, an
  // expired index leaves the app with no days to show while 13 days of valid
  // shards sit untouched behind it. Ageing the two out together means a stalled
  // cycle degrades to slightly stale data rather than an empty screen.
  gamesIndex:    13 * 24 * 3600, // 13 days — day index
};

// ── Win-probability sports ────────────────────────────────────────────────────
// Sports where ESPN exposes win probability — gates whether WP tracking runs.
// Derived from the presence of `action` multipliers in SPORTS: a sport has
// action tuning exactly when ESPN provides WP for it. Soccer is absent —
// ESPN doesn't expose WP for soccer.
export const WP_SPORTS = new Set(
  Object.entries(SPORTS).filter(([, cfg]) => cfg.action).map(([key]) => key)
);

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
export const HOURS_WINDOW = 288; // show games from last 12 days

// The bare GET /api/games (no ?date=) still returns one flat list, because app
// versions shipped before per-day loading depend on it. It is composed from the
// newest LEGACY_DAYS shards per request — 5 days keeps those clients seeing
// exactly the window they always have, without the 12-day list they can't page
// through. New clients use ?date= and never fetch it.
export const LEGACY_DAYS = 5;

// ET calendar date ('YYYY-MM-DD') for a game timestamp. Day sharding is
// ET-anchored like everything else here (ESPN's scoreboard dates are ET), so a
// game lands on exactly one day regardless of server or client timezone. Note
// this moves late West-Coast games a day forward relative to local-time
// grouping — a 9pm PT start is already tomorrow in ET.
export function etDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}


