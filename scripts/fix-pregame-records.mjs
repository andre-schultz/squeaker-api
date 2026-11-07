#!/usr/bin/env node
// One-off repair: fill in the frozen pre-game record/rank for finished games
// that lost it.
//
// Applied to production 2026-11-07 (see the restore/repair runs in that day's
// incident); kept for reference and for re-use if it happens again.
//
// A done game's record/rank comes from a snapshot taken while the game was
// still scheduled or live (see _pregameMeta in src/services/espn.js). A game the
// server first sees already final — because its league wasn't being processed
// (CFB outage, 2026-11-07) or because it ended while the server was restarting
// — has no snapshot and is stored with record: null.
//
// ESPN's record on a final game already includes that game's result, so the
// pre-game record is that record minus the result:
// It also repairs the opposite failure: a saved record that equals ESPN's
// post-game record for that game, i.e. the result leaked onto the card.
//
//   W-L      (football, basketball) → winner W-1, loser L-1
//   W-L-OTL  (NHL)                  → winner W-1, loser OTL-1 if the game went
//                                     to OT/shootout, else L-1
// Rank comes straight from ESPN's curatedRank on that game (poll rank at game
// time). Other record formats (soccer W-D-L) are skipped.
//
// Only run this for days whose games the teams haven't played again since — a
// later game would also be folded into ESPN's record.
//
// Usage (needs UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, e.g. via .env):
//   node scripts/fix-pregame-records.mjs 2026-11-06 2026-11-07            # dry run
//   node scripts/fix-pregame-records.mjs 2026-11-06 2026-11-07 --apply
//   --sports cfb,nhl     which leagues to repair (default cfb,nfl,nhl)
//   --spoilers-only      only replace leaked post-game records, never fill
//   node scripts/fix-pregame-records.mjs 2026-11-07 --check   # validate the
//        derivation against games that DID keep their snapshot; writes nothing

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { Redis } from '@upstash/redis';
import { SPORTS, CACHE_TTL } from '../src/config.js';

const { values: args, positionals: dates } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    // Spoiler repair (post-game record saved as pre-game) applies to any league
    // listed here. College basketball and soccer are excluded by default: early-season and
    // non-D-I teams (and NWSL playoffs) legitimately have no record, so a null
    // there isn't damage and filling it would add a record that never showed.
    sports: { type: 'string', default: 'cfb,nfl,nhl' },
    // Only repair post-game spoilers; never fill a missing record. Use with
    // --sports cbb,wcbb,nba where a missing record is normal early-season.
    'spoilers-only': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
if (!dates.length || !dates.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
  console.error('usage: fix-pregame-records.mjs YYYY-MM-DD [...] [--apply|--check]');
  process.exit(1);
}

const sports = new Set(args.sports.split(','));

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const scoreboards = new Map(); // `${sport}:${date}` → events by id

async function espnEvents(sport, date) {
  const key = `${sport}:${date}`;
  if (scoreboards.has(key)) return scoreboards.get(key);
  const cfg = SPORTS[sport];
  const params = [`dates=${date.replace(/-/g, '')}`, 'limit=500'];
  if (cfg.conference?.group) params.push(`groups=${cfg.conference.group}`);
  const res = await fetch(`${BASE}/${cfg.espnSport}/${cfg.espnLeague}/scoreboard?${params.join('&')}`,
    { headers: { 'User-Agent': 'Squeaker/1.0' } });
  if (!res.ok) throw new Error(`ESPN ${sport} ${date}: HTTP ${res.status}`);
  const byId = new Map(((await res.json()).events || []).map(e => [e.id, e]));
  scoreboards.set(key, byId);
  return byId;
}

function rankOf(T) {
  const r = T.curatedRank?.current;
  return Number.isFinite(r) && r > 0 && r < 99 ? r : null;
}

// Pre-game record for one side, or null when it can't be derived safely.
function pregameRecord(T, won, wentToOT) {
  // NHL lists a finished game's season record as type 'ytd' rather than 'total'.
  const post = (T.records?.find(x => x.type === 'total') ?? T.records?.find(x => x.type === 'ytd'))?.summary;
  if (typeof post !== 'string') return null;
  const parts = post.split('-').map(Number);
  if (!parts.every(Number.isInteger)) return null;
  if (parts.length === 2) {
    const [w, l] = parts;
    const pre = won ? [w - 1, l] : [w, l - 1];
    return pre.every(n => n >= 0) ? pre.join('-') : null;
  }
  if (parts.length === 3 && T.__sport === 'nhl') {
    const [w, l, otl] = parts;
    const pre = won ? [w - 1, l, otl] : wentToOT ? [w, l, otl - 1] : [w, l - 1, otl];
    return pre.every(n => n >= 0) ? pre.join('-') : null;
  }
  return null; // soccer W-D-L and anything unrecognised
}

let fixed = 0, skipped = 0, checked = 0, mismatched = 0;

for (const date of dates) {
  const key = `games:day:${date}`;
  const shard = (await redis.get(key)) || [];
  let dirty = false;

  for (const g of shard) {
    if (!g?.done || !SPORTS[g.sport]) continue;
    const missing = g.home.record == null || g.away.record == null;
    if (args.check && missing) continue;
    if (!sports.has(g.sport)) continue;

    let ev;
    try { ev = (await espnEvents(g.sport, date)).get(g.id); }
    catch (e) { console.log(`  !  ${g.sport} ${g.id}: ${e.message}`); skipped++; continue; }
    const co = ev?.competitions?.[0];
    if (!co?.status?.type?.completed) { skipped++; continue; }

    const label = `${date} ${g.sport} ${g.away.abbr} @ ${g.home.abbr} (${g.id})`;
    const derived = {}, post = {};
    for (const side of ['home', 'away']) {
      const T = co.competitors.find(c => c.homeAway === side);
      if (!T) continue;
      T.__sport = g.sport;
      derived[side] = { record: pregameRecord(T, !!T.winner, !!g.isOT), rank: rankOf(T) };
      post[side] = (T.records?.find(x => x.type === 'total') ?? T.records?.find(x => x.type === 'ytd'))?.summary ?? null;
    }

    if (args.check) {
      checked++;
      const ok = ['home', 'away'].every(s => derived[s]?.record === g[s].record);
      if (!ok) {
        mismatched++;
        console.log(`  ✗  ${label}: stored ${g.away.record} @ ${g.home.record}, derived ${derived.away?.record} @ ${derived.home?.record}`);
      }
      continue;
    }

    // Missing → fill. Present but equal to ESPN's POST-game record for this game
    // (a spoiler: the snapshot was overwritten after ESPN folded the result in)
    // → replace with the derived pre-game record. Anything else is left alone.
    const changes = [];
    for (const side of ['home', 'away']) {
      const d = derived[side];
      if (!d?.record) continue;
      if (g[side].record == null) {
        if (args['spoilers-only']) continue;
        changes.push(`${g[side].abbr} — → ${d.record}${d.rank ? ` #${d.rank}` : ''}`);
        g[side].record = d.record;
        if (g[side].rank == null && d.rank) g[side].rank = d.rank;
      } else if (g[side].record === post[side] && g[side].record !== d.record) {
        changes.push(`${g[side].abbr} ${g[side].record} (post-game) → ${d.record}`);
        g[side].record = d.record;
      }
    }
    if (!changes.length) { if (missing) skipped++; continue; }
    console.log(`  +  ${label}: ${changes.join(', ')}`);
    fixed++; dirty = true;
  }

  if (dirty && args.apply) await redis.set(key, shard, { ex: CACHE_TTL.dayShard });
}

if (args.check) {
  console.log(`\nCHECK — ${checked} games with a stored snapshot, ${mismatched} where the derivation disagrees`);
} else {
  console.log(`\n${args.apply ? 'APPLIED' : 'DRY RUN'} — filled ${fixed}, skipped ${skipped}`);
}
