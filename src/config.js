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
  liveGames:     180,   // 3 min — live games
  finishedGames: 600,   // 10 min — finished games
  buzzLive:      180,   // 3 min
  buzzFinished:  900,   // 15 min
};

// ── Time window ───────────────────────────────────────────────────────────────
export const HOURS_WINDOW = 120; // show games from last 5 days