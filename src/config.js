// ── Sport configurations ──────────────────────────────────────────────────────
export const SPORTS = {
  nba: {
    name: 'NBA', emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'nba',
    sub: 'nba',
    margins: { great: 3, good: 8, ok: 15, blowout: 25 },
    base: { comments: 3000, upvotes: 500, velocity: 500 },
  },
  nhl: {
    name: 'NHL', emoji: '🏒',
    espnSport: 'hockey', espnLeague: 'nhl',
    sub: 'hockey',
    margins: { great: 1, good: 2, ok: 3, blowout: 5 },
    base: { comments: 800, upvotes: 200, velocity: 150 },
  },
  mlb: {
    name: 'MLB', emoji: '⚾',
    espnSport: 'baseball', espnLeague: 'mlb',
    sub: 'baseball',
    margins: { great: 1, good: 2, ok: 4, blowout: 7 },
    base: { comments: 800, upvotes: 200, velocity: 150 },
  },
  nfl: {
    name: 'NFL', emoji: '🏈',
    espnSport: 'football', espnLeague: 'nfl',
    sub: 'nfl',
    margins: { great: 3, good: 7, ok: 14, blowout: 24 },
    base: { comments: 5000, upvotes: 800, velocity: 800 },
  },
  cfb: {
    name: 'College FB', emoji: '🏈',
    espnSport: 'football', espnLeague: 'college-football',
    sub: 'CFB',
    margins: { great: 3, good: 7, ok: 14, blowout: 24 },
    base: { comments: 2000, upvotes: 400, velocity: 300 },
  },
  cbb: {
    name: 'College BB', emoji: '🏀',
    espnSport: 'basketball', espnLeague: 'mens-college-basketball',
    sub: 'CollegeBasketball',
    margins: { great: 3, good: 8, ok: 15, blowout: 25 },
    base: { comments: 400, upvotes: 100, velocity: 80 },
  },
  mls: {
    name: 'MLS', emoji: '⚽',
    espnSport: 'soccer', espnLeague: 'usa.1',
    sub: 'MLS',
    margins: { great: 1, good: 2, ok: 3, blowout: 4 },
    base: { comments: 300, upvotes: 80, velocity: 60 },
  },
  epl: {
    name: 'EPL', emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    espnSport: 'soccer', espnLeague: 'eng.1',
    sub: 'soccer',
    margins: { great: 1, good: 2, ok: 3, blowout: 4 },
    base: { comments: 1500, upvotes: 400, velocity: 300 },
  },
  ucl: {
    name: 'Champions League', emoji: '⭐',
    espnSport: 'soccer', espnLeague: 'uefa.champions',
    sub: 'soccer',
    margins: { great: 1, good: 2, ok: 3, blowout: 4 },
    base: { comments: 2000, upvotes: 500, velocity: 400 },
  },
};

// ── Excitement language ───────────────────────────────────────────────────────
// Researched from real game threads (LAFC vs SDFC, MLS May 2026, etc.)
export const EXCITEMENT_WORDS = [
  // Classic hype
  'insane', 'unbelievable', 'clutch', 'legendary', 'crazy', 'incredible',
  'amazing', 'omg', 'wow', 'wild', 'nuts', 'epic', 'hype', 'electric',
  'fire', 'unreal', 'screaming', 'goat',

  // Game situation language
  'what a game', 'at the death', 'stoppage time', 'injury time',
  'dramatic', 'comeback', 'scenes', 'stunner', 'oh my god',
  'hold on', 'game on', 'levels it', 'equalizer', 'ties it',
  'last minute', 'late goal', 'buzzer', 'walk off', 'walk-off',
  'overtime', 'sudden death', 'penalty', 'shootout',

  // Reaction language
  'crumbling', 'roaring back', 'turnaround', 'buries it',
  'can you believe', 'unreal drama', 'absolute scenes',
  'i cant', "i can't", 'no way', 'are you kidding',
  'what just happened', 'holy', 'insane finish', 'crazy end',
  'pulling level', 'fight back', 'never give up',
];

export const BORING_WORDS = [
  'boring', 'blowout', 'unwatchable', 'garbage', 'terrible', 'awful',
  'disappointing', 'lopsided', 'snooze', 'trash', 'pathetic',
  'nothing game', 'dead rubber', 'no contest', 'walk in the park',
  'waste of time', 'gave up', 'stopped watching', 'turned it off',
];

// ── Cache TTLs (seconds) ──────────────────────────────────────────────────────
export const CACHE_TTL = {
  liveGames:     180,    // 3 min — live games
  finishedGames: 600,    // 10 min — finished games
  buzzPeak:      432000, // 5 days — peak buzz, refreshed each time it climbs
  chatterPeak:   432000, // 5 days — peak Bluesky chatter, sticky high-water mark
  articles:      3600,   // 1 hour — finished games' editorial coverage
  articlesLive:  600,    // 10 min — live games refresh more often
  probabilities:  30 * 24 * 3600, // 30 days — WP timeline, mirrors score timeline
  frozenOdds:     30 * 24 * 3600, // 30 days — pre-game line, fetched once
  liveActionPeak: 30 * 24 * 3600, // 30 days — peak live-action score per game
  audit:          3 * 24 * 3600,  // 3 days — algorithm audit log
};

// ── Win-probability sliding-window lengths (per sport) ────────────────────────
// Drama signal = "the game flipped within this window". Window length adapts
// to each sport's natural drama cadence so a 25% threshold means the same
// thing across NBA (gradual WP) and MLB (one-swing-can-flip-it).
export const WP_WINDOW_MS = {
  nba: 2 * 60_000,   // 2 min — typical clutch run
  cbb: 2 * 60_000,
  nfl: 90_000,       // ~1 drive
  cfb: 90_000,
  mlb: 12 * 60_000,  // ~1 half-inning at modern pace
  nhl: 5 * 60_000,   // meaningful in a 60-min game
  // soccer (mls/epl/ucl) intentionally absent — ESPN doesn't expose WP for soccer
};

// ── Feature flags ─────────────────────────────────────────────────────────────
// Accept any common "truthy" string so dashboard inputs like "True", "1",
// or "yes" don't silently fail.
function isTruthy(v) {
  if (v == null) return false;
  return ['true', '1', 'yes', 'on', 'y'].includes(String(v).toLowerCase().trim());
}

// Reddit polling is disabled by default until OAuth is wired up — Reddit's
// unauthenticated API returns 403 from cloud-provider IPs (Railway, AWS, etc).
// Set REDDIT_ENABLED=true in the Railway env once OAuth credentials are in
// place to re-enable the buzz cycle without a code change.
export const REDDIT_ENABLED = isTruthy(process.env.REDDIT_ENABLED);

// Algorithm audit logging — captures every signal the score depends on plus
// the per-bonus breakdown of the final excitement score. Off by default to
// keep DB writes minimal; flip on when actively tuning weights.
export const AUDIT_ENABLED = isTruthy(process.env.AUDIT_ENABLED);

// ── Time window ───────────────────────────────────────────────────────────────
export const HOURS_WINDOW = 120; // show games from last 5 days

// ── Reddit polling ────────────────────────────────────────────────────────────
// Subreddits we poll in bulk. Each cycle we hit hot.json once per sub and
// match the returned posts to ongoing games — no per-game searches.
// Covers general sports buzz + the per-league subs used in SPORTS above.
export const REDDIT_SUBS = [
  'sports',            // cross-sport general buzz
  'sportsbook',        // line-movement chatter, often game-specific
  'nba',
  'nfl',
  'baseball',          // MLB
  'hockey',            // NHL
  'CFB',               // college football
  'CollegeBasketball', // college basketball
  'MLS',
  'soccer',            // EPL/UCL chatter lives here
];

// How many posts to pull per subreddit per cycle (Reddit caps at 100).
export const REDDIT_POSTS_PER_SUB = 100;

// ── Bluesky chatter ───────────────────────────────────────────────────────────
// Per-game queries against the public AppView's searchPosts endpoint. Each
// game gets its own search ("<homeName> <awayName>", sort=latest, since=
// game−30min) so a game's chatter score reflects actual posts about THAT
// game rather than a fixed pool divvied up across the league. Popular games
// naturally outscore quiet ones — that's the whole point.
export const BLUESKY_ENABLED = process.env.BLUESKY_ENABLED == null
  ? true
  : isTruthy(process.env.BLUESKY_ENABLED);

// Per-game search limit. Bluesky's searchPosts caps at 100 per call.
export const BLUESKY_LIMIT_PER_GAME = 100;

// Delay between per-game queries, ms. Public AppView allows ~3000 req/5min/IP.
export const BLUESKY_QUERY_DELAY_MS = 250;

// How early before tipoff a post counts as "about this game".
export const BLUESKY_SINCE_OFFSET_MS = 30 * 60 * 1000; // 30 min

// Engagement baselines for the 0-100 chatter scale. Single global set (not
// per-sport) so popularity bias flows through: an NBA finals naturally hits
// the ceiling, a Tuesday MLS game lands in the 5-15 range. Tune these once
// real data shows where games actually cluster.
export const CHATTER_BASELINES = {
  posts:   30,    // matched posts in a single 30-min-window snapshot
  likes:   1500,
  reposts: 400,
  replies: 250,
};
