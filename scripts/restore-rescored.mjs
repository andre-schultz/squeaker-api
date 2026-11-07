#!/usr/bin/env node
// One-off: undo the re-scoring done by the reverted timeline-backfill commit
// (3e9ddbc, live on main briefly on 2026-11-07).
//
// That commit re-scored done games whose polled score timeline didn't start at
// 0-0 and marked every game it scored with a `timelineComplete` field. The
// original score of each game is still in its history:{date}:{id} row, which is
// written once when the game first finishes and never overwritten afterwards.
//
// For every game in the day shards that carries `timelineComplete` and whose
// excitement differs from its history row, this restores the excitement,
// momentum, comeback and description fields from history and drops the flag.
//
// Usage (needs UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, e.g. via .env):
//   node scripts/restore-rescored.mjs                      # dry run, prints changes
//   node scripts/restore-rescored.mjs --apply              # write the shards
//   node scripts/restore-rescored.mjs --keep cfb:2026-11-07 [--apply]
//        leave that league+day re-scored (e.g. games missed during an outage)
//
// Then RESTART the server: it holds the game list in memory and would write the
// re-scored values back into a day's shard the next time that day changes.

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { Redis } from '@upstash/redis';
import { CACHE_TTL } from '../src/config.js';

const { values: args } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    keep:  { type: 'string', multiple: true, default: [] },
  },
});
const keep = new Set(args.keep);

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const index = (await redis.get('games:index')) || [];
let restored = 0, kept = 0, noHistory = 0, unchanged = 0;

for (const { date } of index) {
  const key = `games:day:${date}`;
  const shard = (await redis.get(key)) || [];
  let dirty = false;

  for (let i = 0; i < shard.length; i++) {
    const g = shard[i];
    if (!g?.done || !('timelineComplete' in g)) continue;

    // history rows are keyed by the UTC date of game.date (see saveHistory).
    const hDate = new Date(g.date).toISOString().slice(0, 10);
    const h = await redis.get(`history:${hDate}:${g.id}`);
    const label = `${date} ${g.sport} ${g.away?.abbr} @ ${g.home?.abbr} (${g.id})`;

    if (!h || typeof h.excitementScore !== 'number') { noHistory++; console.log(`  ?  ${label}: no history row — left as is (${g.excitement})`); continue; }
    if (h.excitementScore === g.excitement) {
      unchanged++;
      const { timelineComplete, ...rest } = g; shard[i] = rest; dirty = true; // drop the flag only
      continue;
    }
    if (keep.has(`${g.sport}:${date}`)) { kept++; console.log(`  =  ${label}: kept re-scored ${g.excitement} (was ${h.excitementScore})`); continue; }

    console.log(`  ←  ${label}: ${g.excitement} → ${h.excitementScore}`);
    const { timelineComplete, ...rest } = g;
    shard[i] = {
      ...rest,
      excitement:      h.excitementScore,
      desc:            h.excitementDesc ?? g.desc,
      momentumBonus:   h.momentumBonus ?? g.momentumBonus,
      momentumSignals: h.momentumSignals ?? g.momentumSignals,
      comebackBonus:   h.comebackBonus ?? g.comebackBonus,
      comebackSignals: h.comebackSignals ?? g.comebackSignals,
      isComeback:      h.isComeback ?? g.isComeback,
    };
    restored++; dirty = true;
  }

  if (dirty && args.apply) {
    shard.sort((a, b) => b.excitement - a.excitement);
    await redis.set(key, shard, { ex: CACHE_TTL.dayShard });
  }
}

console.log(`\n${args.apply ? 'APPLIED' : 'DRY RUN'} — restored ${restored}, kept ${kept}, unchanged ${unchanged}, no history ${noHistory}`);
if (!args.apply) console.log('Re-run with --apply to write. Restart the server afterwards.');
