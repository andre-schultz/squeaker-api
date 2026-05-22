#!/usr/bin/env node
// Analyze stats-bonus score distribution for games from the last 24h, broken down by sport.
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL   || 'https://smooth-raptor-113975.upstash.io',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAb03AAIgcDJiYzFlN2Q3YzU5ZDQ0YmI1YWQ4OTIwMjQzOTNjYTQ3Ng',
});

const NOW = Date.now();
const CUTOFF = NOW - 24 * 60 * 60 * 1000;

// ── 1. Load all games ──────────────────────────────────────────────────────────
const games = await redis.get('games:all');
if (!games) { console.error('No games:all key found in Redis.'); process.exit(1); }

const allGames = Array.isArray(games) ? games : JSON.parse(games);

// Filter to last 24h — use startTime or date field
const recent = allGames.filter(g => {
  const t = g.startTime ? new Date(g.startTime).getTime() : (g.date ? new Date(g.date).getTime() : 0);
  return t >= CUTOFF;
});

console.log(`\nTotal games in cache: ${allGames.length}`);
console.log(`Games in last 24h:    ${recent.length}\n`);

// ── 2. Fetch stats-bonus for each recent game ─────────────────────────────────
const bonusKeys = recent.map(g => `stats-bonus:${g.id}`);

// Batch fetch with mget — Upstash supports it
let bonuses = [];
if (bonusKeys.length > 0) {
  // mget returns array in same order as keys
  const raw = await redis.mget(...bonusKeys);
  bonuses = raw.map((b, i) => ({
    game: recent[i],
    bonus: b ? (typeof b === 'string' ? JSON.parse(b) : b) : null,
  }));
} else {
  bonuses = recent.map(g => ({ game: g, bonus: null }));
}

// ── 3. Build per-sport buckets ────────────────────────────────────────────────
const SPORT_LABELS = {
  nba: 'NBA 🏀', nhl: 'NHL 🏒', mlb: 'MLB ⚾', nfl: 'NFL 🏈',
  cfb: 'CFB 🏈', cbb: 'CBB 🏀', mls: 'MLS ⚽', epl: 'EPL 🏴',
  ucl: 'UCL ⭐', wnba: 'WNBA 🏀', nwsl: 'NWSL ⚽', wcbb: 'WCBB 🏀',
};

const byDport = {};

for (const { game, bonus } of bonuses) {
  const sport = game.sport || 'unknown';
  if (!byDport[sport]) byDport[sport] = [];
  byDport[sport].push({
    id:         game.id,
    name:       `${game.away?.abbr ?? '???'} @ ${game.home?.abbr ?? '???'} (${game.away?.score ?? '?'}-${game.home?.score ?? '?'})`,
    excitement: game.excitement ?? null,
    statsBonus: bonus?.score ?? null,
    done:       game.done ?? false,
    live:       game.live ?? false,
  });
}

// ── 4. Print distribution table ───────────────────────────────────────────────
const BUCKETS = [
  { label: '1–3  (low)',    min: 1,  max: 3  },
  { label: '4–6  (med)',    min: 4,  max: 6  },
  { label: '7–9  (high)',   min: 7,  max: 9  },
  { label: '10–12 (great)', min: 10, max: 12 },
  { label: '13–15 (elite)', min: 13, max: 15 },
];

function bucket(score) {
  if (score == null) return 'N/A';
  return BUCKETS.find(b => score >= b.min && score <= b.max)?.label ?? '???';
}

function avg(arr) {
  const v = arr.filter(x => x != null);
  return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : 'N/A';
}

function bar(n, total, width = 20) {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((n / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Overall distribution ───────────────────────────────────────────────────────
const allScores = bonuses.map(b => b.bonus?.score ?? null).filter(s => s != null);

console.log('═'.repeat(70));
console.log('  STATS BONUS SCORE DISTRIBUTION — Last 24h');
console.log('═'.repeat(70));

if (allScores.length === 0) {
  console.log('\n  No stats-bonus data found for any games in the last 24h.\n');
} else {
  console.log(`\n  Games with stats data: ${allScores.length} / ${recent.length}`);
  console.log(`  Overall avg score:     ${avg(allScores)}  (range 1–15)\n`);

  console.log('  Distribution (all sports):');
  for (const b of BUCKETS) {
    const count = allScores.filter(s => s >= b.min && s <= b.max).length;
    const pct = ((count / allScores.length) * 100).toFixed(0);
    console.log(`    ${b.label.padEnd(15)}  ${bar(count, allScores.length)}  ${String(count).padStart(3)} (${String(pct).padStart(3)}%)`);
  }
}

// ── Per-sport breakdown ────────────────────────────────────────────────────────
const sports = Object.keys(byDport).sort();

for (const sport of sports) {
  const entries = byDport[sport];
  const label = SPORT_LABELS[sport] ?? sport.toUpperCase();
  const scores = entries.map(e => e.statsBonus).filter(s => s != null);
  const excitements = entries.map(e => e.excitement).filter(s => s != null);

  console.log('\n' + '─'.repeat(70));
  console.log(`  ${label}  (${entries.length} games, ${scores.length} with stats data)`);
  console.log('─'.repeat(70));

  if (scores.length === 0) {
    console.log('  No stats-bonus data available.');
  } else {
    console.log(`  Avg stats bonus: ${avg(scores).padStart(4)}    Avg excitement: ${avg(excitements).padStart(5)}\n`);

    for (const b of BUCKETS) {
      const count = scores.filter(s => s >= b.min && s <= b.max).length;
      if (count === 0) continue;
      const pct = ((count / scores.length) * 100).toFixed(0);
      console.log(`    ${b.label.padEnd(15)}  ${bar(count, scores.length, 16)}  ${String(count).padStart(3)} (${String(pct).padStart(3)}%)`);
    }
  }

  console.log('\n  Individual games:');
  const sorted = [...entries].sort((a, b) => (b.statsBonus ?? 0) - (a.statsBonus ?? 0));
  for (const e of sorted) {
    const status = e.live ? '🔴 LIVE' : e.done ? '✅ done' : '🕐 sched';
    const sb = e.statsBonus != null ? String(e.statsBonus).padStart(2) : ' -';
    const ex = e.excitement != null ? String(e.excitement).padStart(3) : '  -';
    console.log(`    [stats:${sb}] [exc:${ex}]  ${status}  ${e.name}`);
  }
}

console.log('\n' + '═'.repeat(70) + '\n');
