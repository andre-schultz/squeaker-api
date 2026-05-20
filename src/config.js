// ── Sport configurations ──────────────────────────────────────────────────────
export const SPORTS = {
  nba: {
    name: 'NBA', emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'nba',
    margins: { great: 3, good: 8, ok: 15, blowout: 25 },
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
  },
  cbb: {
    name: 'College BB', emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'mens-college-basketball',
    margins: { great: 3, good: 8, ok: 15, blowout: 25 },
  },
  mls: {
    name: 'MLS', emoji: '⚽',
    espnSport: 'soccer', espnLeague: 'usa.1',
    margins: { great: 1, good: 2, ok: 3, blowout: 4 },
  },
  epl: {
    name: 'EPL', emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    espnSport: 'soccer', espnLeague: 'eng.1',
    margins: { great: 1, good: 2, ok: 3, blowout: 4 },
  },
  ucl: {
    name: 'Champions League', emoji: '⭐',
    espnSport: 'soccer', espnLeague: 'uefa.champions',
    margins: { great: 1, good: 2, ok: 3, blowout: 4 },
  },
  wnba: {
    name: 'WNBA', emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'wnba',
    margins: { great: 3, good: 8, ok: 15, blowout: 25 },
  },
  nwsl: {
    name: 'NWSL', emoji: '⚽',
    espnSport: 'soccer', espnLeague: 'usa.nwsl',
    margins: { great: 1, good: 2, ok: 3, blowout: 4 },
  },
  wcbb: {
    name: "Women's College BB", emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'womens-college-basketball',
    margins: { great: 3, good: 8, ok: 15, blowout: 25 },
  },
};

// ── Cache TTLs (seconds) ──────────────────────────────────────────────────────
export const CACHE_TTL = {
  liveGames:     180,    // 3 min — live games
  finishedGames: 600,    // 10 min — finished games
  probabilities:  7 * 24 * 3600, // 7 days — WP timeline, mirrors score timeline
  frozenOdds:     7 * 24 * 3600, // 7 days — pre-game line, fetched once
  liveActionPeak: 7 * 24 * 3600, // 7 days — peak live-action score per game
  audit:          3 * 24 * 3600, // 3 days — algorithm audit log
  oddsTimeline:   7 * 24 * 3600, // 7 days — SGO live-odds WP timeline
  bettingPeak:    7 * 24 * 3600, // 7 days — peak betting score per game
  stats:          7 * 24 * 3600, // 7 days — team/goalie stats snapshots
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
  // soccer (mls/epl/ucl/nwsl) intentionally absent — ESPN doesn't expose WP for soccer
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

// ── SportsGameOdds live odds ──────────────────────────────────────────────────
// Enabled automatically when SGO_API_KEY is present. No separate flag needed —
// the key being set is the opt-in. Polls live in-game moneylines every 10 min
// (matching SGO's free-tier update frequency) for all live games.
export const SGO_ENABLED = !!process.env.SGO_API_KEY;


