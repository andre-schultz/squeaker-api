// One-off migration: seed games:day:{date} shards + games:index from the
// pre-sharding games:all key, and park games:all as a static snapshot for app
// versions that predate per-day loading.
//
// The service itself has no fallback for this — runGameCycle reads the shards
// and nothing else — so this has to run BEFORE the sharding deploy, or the
// existing window is lost and rebuilds from ESPN over the following days.
//
// Order matters:
//   1. --commit          (now, while the old code is still running)
//   2. deploy the sharding build
//   3. --expire-legacy   (after the deploy, once nothing rewrites games:all —
//                         doing it earlier just gets clobbered by the next
//                         cycle's 30-minute SET)
//
// Usage:
//   node --env-file=.env scripts/migrate-day-shards.mjs              # dry run
//   node --env-file=.env scripts/migrate-day-shards.mjs --commit
//   node --env-file=.env scripts/migrate-day-shards.mjs --expire-legacy [--commit]

import { redis } from '../src/services/cache.js';
import { CACHE_TTL, etDayKey } from '../src/config.js';

const args         = process.argv.slice(2);
const commit       = args.includes('--commit');
const expireLegacy = args.includes('--expire-legacy');
const LEGACY_TTL   = 5 * 24 * 3600; // 5 days — old clients keep their usual window

const plan = [];
const label = commit ? 'WRITE' : 'DRY-RUN';

if (expireLegacy) {
  const ttl = await redis.ttl('games:all');
  const raw = await redis.get('games:all');
  const n = Array.isArray(raw) ? raw.length : 0;
  console.log(`games:all — ${n} games, current TTL ${ttl}s`);
  if (n === 0) {
    console.log('nothing there to preserve; skipping');
  } else {
    console.log(`${label}: EXPIRE games:all ${LEGACY_TTL}s (${LEGACY_TTL / 86400} days)`);
    if (commit) {
      await redis.expire('games:all', LEGACY_TTL);
      console.log(`done — TTL now ${await redis.ttl('games:all')}s`);
    }
  }
  process.exit(0);
}

const games = (await redis.get('games:all')) || [];
if (games.length === 0) {
  console.error('games:all is empty or missing — nothing to migrate.');
  process.exit(1);
}

// Same grouping the warmup cycle applies, so a migrated shard is byte-identical
// in shape to one the service would have written itself.
const byDay = new Map();
let undated = 0;
for (const g of games) {
  const key = etDayKey(g.date);
  if (!key) { undated++; continue; }
  if (!byDay.has(key)) byDay.set(key, []);
  byDay.get(key).push(g);
}

const dates = [...byDay.keys()].sort((a, b) => b.localeCompare(a)); // newest first
const index = dates.map(date => ({
  date,
  count:  byDay.get(date).length,
  live:   byDay.get(date).filter(g => g.live).length,
  sports: [...new Set(byDay.get(date).map(g => g.sport))],
}));

console.log(`games:all — ${games.length} games${undated ? ` (${undated} undated, skipped)` : ''}`);
console.log(`→ ${dates.length} day shards\n`);
for (const d of index) {
  const bytes = JSON.stringify(byDay.get(d.date)).length;
  console.log(`  games:day:${d.date}  ${String(d.count).padStart(3)} games  ${(bytes / 1024).toFixed(1)}KB`);
  plan.push(d.date);
}
console.log(`\n  games:index          ${index.length} rows`);
console.log(`\n${label}: ${plan.length} shards (TTL ${CACHE_TTL.dayShard}s) + index (TTL ${CACHE_TTL.gamesIndex}s)`);

if (!commit) {
  console.log('\nDry run — nothing written. Re-run with --commit to apply.');
  process.exit(0);
}

for (const date of dates) {
  const dayGames = byDay.get(date).sort((a, b) => b.excitement - a.excitement);
  await redis.set(`games:day:${date}`, dayGames, { ex: CACHE_TTL.dayShard });
}
await redis.set('games:index', index, { ex: CACHE_TTL.gamesIndex });

// Read back so a silent write failure can't look like success.
const check = (await redis.get('games:index')) || [];
const total = (await Promise.all(
  check.map(d => redis.get(`games:day:${d.date}`).then(s => (s || []).length))
)).reduce((a, b) => a + b, 0);
console.log(`\nverified: index has ${check.length} days, shards hold ${total} games (expected ${games.length - undated})`);
process.exit(total === games.length - undated ? 0 : 1);
