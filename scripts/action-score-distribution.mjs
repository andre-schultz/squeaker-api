#!/usr/bin/env node
// Historical action score distribution analysis.
//
// Fetches ESPN's full play-by-play WP history for completed games across a
// date range and computes the rate-based action score. Designed for large
// multi-sport, multi-month runs.
//
// Usage:
//   node scripts/action-score-distribution.mjs
//     → last 2 days, all WP-tracked sports
//
//   node scripts/action-score-distribution.mjs --start 20251001 --end 20251231 --sport nfl,nba,cbb,wcbb
//   node scripts/action-score-distribution.mjs --start 20260422 --end 20260522 --sport mlb

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ── Env ───────────────────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(resolve(__dir, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch { /* fall through */ }

// ── Args ──────────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    start:  { type: 'string' },
    end:    { type: 'string' },
    sport:  { type: 'string' },
  },
  strict: false,
});

// ── Formula (mirrors probabilities.js) ───────────────────────────────────────
const SWING_THRESHOLD = 0.03;
const PAGE_SIZE       = 300;

const ACTION_MULTIPLIERS = {
  mlb:  { avgSwing: 800,  consecRate: 60,  semiRate: 40 },
  nba:  { avgSwing: 1200, consecRate: 90,  semiRate: 60 },
  wnba: { avgSwing: 1200, consecRate: 90,  semiRate: 60 },
  nfl:  { avgSwing: 1400, consecRate: 110, semiRate: 70 },
  cfb:  { avgSwing: 1300, consecRate: 100, semiRate: 65 },
  nhl:  { avgSwing: 1100, consecRate: 85,  semiRate: 55 },
  cbb:  { avgSwing: 1600, consecRate: 120, semiRate: 80 },
  wcbb: { avgSwing: 1600, consecRate: 120, semiRate: 80 },
};

// ── Sport config ──────────────────────────────────────────────────────────────
const ALL_SPORTS = {
  nba:  { name: 'NBA',                espnSport: 'basketball', espnLeague: 'nba' },
  mlb:  { name: 'MLB',                espnSport: 'baseball',   espnLeague: 'mlb' },
  nhl:  { name: 'NHL',                espnSport: 'hockey',     espnLeague: 'nhl' },
  nfl:  { name: 'NFL',                espnSport: 'football',   espnLeague: 'nfl' },
  cfb:  { name: 'CFB',                espnSport: 'football',   espnLeague: 'college-football' },
  wnba: { name: 'WNBA',               espnSport: 'basketball', espnLeague: 'wnba' },
  cbb:  { name: 'College BB',         espnSport: 'basketball', espnLeague: 'mens-college-basketball' },
  wcbb: { name: "Women's College BB", espnSport: 'basketball', espnLeague: 'womens-college-basketball' },
};

const sportFilter = args.sport ? new Set(args.sport.split(',')) : null;
const SPORTS = Object.fromEntries(
  Object.entries(ALL_SPORTS).filter(([k]) => !sportFilter || sportFilter.has(k))
);

// ── Date helpers ──────────────────────────────────────────────────────────────
function todayStr(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function dateRange(startStr, endStr) {
  const dates = [];
  const cur = new Date(`${startStr.slice(0,4)}-${startStr.slice(4,6)}-${startStr.slice(6,8)}`);
  const end = new Date(`${endStr.slice(0,4)}-${endStr.slice(4,6)}-${endStr.slice(6,8)}`);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0,10).replace(/-/g,''));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

const dates = args.start && args.end
  ? dateRange(args.start, args.end)
  : [todayStr(2), todayStr(1), todayStr(0)];

// ── ESPN helpers ──────────────────────────────────────────────────────────────
const BASE    = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE    = 'https://sports.core.api.espn.com/v2/sports';
const HEADERS = { 'User-Agent': 'Squeaker/1.0' };

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { try { await res.text(); } catch {} return null; }
    return await res.json();
  } catch { return null; }
}

// Run promises in parallel batches to avoid hammering ESPN
async function batchAll(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = await Promise.all(items.slice(i, i + batchSize).map(fn));
    results.push(...batch);
  }
  return results;
}

async function fetchScoreboard(espnSport, espnLeague, dateS) {
  const data = await fetchJSON(`${BASE}/${espnSport}/${espnLeague}/scoreboard?dates=${dateS}&limit=100`);
  return data?.events || [];
}

async function fetchFullWPTimeline(espnSport, espnLeague, eventId) {
  const base = `${CORE}/${espnSport}/leagues/${espnLeague}/events/${eventId}/competitions/${eventId}/probabilities`;
  const first = await fetchJSON(`${base}?limit=${PAGE_SIZE}&page=1`);
  if (!first?.items?.length) return [];

  const pageCount = first.pageCount || 1;
  const allItems  = [...first.items];

  if (pageCount > 1) {
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) =>
        fetchJSON(`${base}?limit=${PAGE_SIZE}&page=${i + 2}`)
      )
    );
    for (const page of rest) if (page?.items) allItems.push(...page.items);
  }

  const raw = allItems
    .filter(e => e.homeWinPercentage != null && e.awayWinPercentage != null)
    .map(e => ({
      homeWP: Math.max(0, Math.min(1, e.homeWinPercentage)),
      awayWP: Math.max(0, Math.min(1, e.awayWinPercentage)),
    }));

  const filtered = [];
  for (const entry of raw) {
    const prev = filtered[filtered.length - 1];
    if (!prev || Math.abs(entry.homeWP - prev.homeWP) >= 0.001) filtered.push(entry);
  }
  return filtered;
}

// ── Formula ───────────────────────────────────────────────────────────────────
function computeActionScore(timeline, sport) {
  const m = ACTION_MULTIPLIERS[sport] ?? ACTION_MULTIPLIERS.mlb;
  const result = { score: 0, avgSwing: 0, consecRate: 0, semiRate: 0, samples: timeline?.length ?? 0 };
  if (!timeline || timeline.length < 2) return result;

  const deltas = [];
  for (let i = 1; i < timeline.length; i++) deltas.push(Math.abs(timeline[i].homeWP - timeline[i-1].homeWP));
  const n = deltas.length;

  result.avgSwing = deltas.reduce((a, b) => a + b, 0) / n;

  let consecCount = 0;
  for (let i = 1; i < n; i++) if (deltas[i] >= SWING_THRESHOLD && deltas[i-1] >= SWING_THRESHOLD) consecCount++;
  result.consecRate = n > 1 ? consecCount / (n - 1) : 0;

  let semiCount = 0;
  for (let i = 2; i < n; i++) if (deltas[i] >= SWING_THRESHOLD && deltas[i-2] >= SWING_THRESHOLD) semiCount++;
  result.semiRate = n > 2 ? semiCount / (n - 2) : 0;

  result.score = Math.min(100, Math.round(
    result.avgSwing   * m.avgSwing +
    result.consecRate * m.consecRate +
    result.semiRate   * m.semiRate
  ));
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`\nFormula: sport-specific multipliers (see ACTION_MULTIPLIERS)  threshold=${SWING_THRESHOLD}`);
console.log(`Dates: ${dates[0]}–${dates[dates.length-1]}  (${dates.length} days)`);
console.log(`Sports: ${Object.keys(SPORTS).join(', ')}\n`);

// Step 1: fetch all scoreboards in parallel batches
process.stdout.write('Fetching scoreboards...');
const scorecardJobs = [];
for (const [sportKey, cfg] of Object.entries(SPORTS)) {
  for (const d of dates) scorecardJobs.push({ sportKey, cfg, d });
}

const scorecardResults = await batchAll(scorecardJobs, 20, async ({ sportKey, cfg, d }) => {
  const events = await fetchScoreboard(cfg.espnSport, cfg.espnLeague, d);
  return { sportKey, cfg, d, events };
});
console.log(` done (${scorecardJobs.length} requests)`);

// Step 2: collect completed games, deduplicate by id
const seenIds = new Set();
const gameJobs = [];
for (const { sportKey, cfg, events } of scorecardResults) {
  for (const ev of events) {
    const s = ev.competitions?.[0]?.status?.type;
    if (!s?.completed) continue;
    if (seenIds.has(ev.id)) continue;
    seenIds.add(ev.id);

    const co   = ev.competitions[0];
    const home = co.competitors?.find(c => c.homeAway === 'home');
    const away = co.competitors?.find(c => c.homeAway === 'away');
    gameJobs.push({ id: ev.id, sportKey, cfg, matchup: `${away?.team?.abbreviation ?? '?'} @ ${home?.team?.abbreviation ?? '?'}` });
  }
}
console.log(`Found ${gameJobs.length} completed games across all sports. Fetching WP timelines...`);

// Step 3: fetch WP timelines in parallel batches, show progress
const allGames = [];
let fetched = 0;
const results = await batchAll(gameJobs, 12, async ({ id, sportKey, cfg, matchup }) => {
  const timeline = await fetchFullWPTimeline(cfg.espnSport, cfg.espnLeague, id);
  fetched++;
  if (fetched % 50 === 0) process.stdout.write(`  ${fetched}/${gameJobs.length}...\n`);
  if (!timeline.length) return null;
  const bd = computeActionScore(timeline, sportKey);
  return { id, sport: sportKey, matchup, score: bd.score, avgSwing: bd.avgSwing, consecRate: bd.consecRate, semiRate: bd.semiRate, samples: bd.samples };
});

for (const g of results) if (g) allGames.push(g);
console.log(`\nScored ${allGames.length} games with WP data.\n`);

if (!allGames.length) { console.log('No games found.'); process.exit(0); }

// ── Per-sport summary ─────────────────────────────────────────────────────────
const activeSports = [...new Set(allGames.map(g => g.sport))];
console.log(`${'═'.repeat(85)}`);
console.log(`ACTION SCORE DISTRIBUTION  (${allGames.length} games)`);
console.log(`${'═'.repeat(85)}`);

for (const s of activeSports) {
  const gs     = allGames.filter(g => g.sport === s);
  const scores = gs.map(g => g.score).sort((a, b) => a - b);
  const avg    = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
  const med    = scores[Math.floor(scores.length / 2)];
  const p25    = scores[Math.floor(scores.length * 0.25)];
  const p75    = scores[Math.floor(scores.length * 0.75)];
  const p90    = scores[Math.floor(scores.length * 0.90)];
  const max    = scores[scores.length - 1];

  const avgAS  = (gs.reduce((a, g) => a + g.avgSwing,   0) / gs.length).toFixed(4);
  const avgCR  = (gs.reduce((a, g) => a + g.consecRate, 0) / gs.length).toFixed(3);
  const avgSR  = (gs.reduce((a, g) => a + g.semiRate,   0) / gs.length).toFixed(3);
  const avgSamp = Math.round(gs.reduce((a, g) => a + g.samples, 0) / gs.length);

  console.log(`\n${ALL_SPORTS[s].name.padEnd(22)} (${gs.length} games, avg ${avgSamp} WP entries/game)`);
  console.log(`  score      avg=${avg}  p25=${p25}  med=${med}  p75=${p75}  p90=${p90}  max=${max}`);
  console.log(`  components avg  avgSwing=${avgAS}  consecRate=${avgCR}  semiRate=${avgSR}`);

  // Mini distribution bar
  const bkts = [
    { lo: 0,  hi: 20  },
    { lo: 21, hi: 40  },
    { lo: 41, hi: 60  },
    { lo: 61, hi: 80  },
    { lo: 81, hi: 100 },
  ];
  const parts = bkts.map(b => {
    const cnt = scores.filter(x => x >= b.lo && x <= b.hi).length;
    const pct = (cnt / scores.length * 100).toFixed(0);
    return `${b.lo}-${b.hi}: ${pct}%`;
  });
  console.log(`  dist       ${parts.join('  ')}`);
}

// ── Overall distribution ──────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log('OVERALL DISTRIBUTION (all sports)');
console.log(`${'─'.repeat(60)}`);

const buckets = [
  { label: '0–10   (flat)',     min: 0,  max: 10  },
  { label: '11–25  (low)',      min: 11, max: 25  },
  { label: '26–40  (mild)',     min: 26, max: 40  },
  { label: '41–60  (moderate)', min: 41, max: 60  },
  { label: '61–75  (elevated)', min: 61, max: 75  },
  { label: '76–90  (high)',     min: 76, max: 90  },
  { label: '91–100 (peak)',     min: 91, max: 100 },
];

const total = allGames.length;
for (const b of buckets) {
  const count = allGames.filter(g => g.score >= b.min && g.score <= b.max).length;
  const pct   = (count / total * 100).toFixed(1);
  const bar   = '█'.repeat(Math.round(count / total * 40));
  console.log(`  ${b.label.padEnd(24)} ${String(count).padStart(5)} (${pct.padStart(5)}%)  ${bar}`);
}

// ── Top 20 games across all sports ───────────────────────────────────────────
const top20 = [...allGames].sort((a, b) => b.score - a.score).slice(0, 20);
console.log(`\n${'─'.repeat(80)}`);
console.log('TOP 20 GAMES');
console.log(`${'─'.repeat(80)}`);
console.log('Score'.padEnd(7), 'Sport'.padEnd(7), 'Samp'.padEnd(6), 'AvgSwg'.padEnd(9), 'CRate'.padEnd(8), 'SRate'.padEnd(8), 'Matchup');
console.log('─'.repeat(80));
for (const g of top20) {
  console.log(
    String(g.score).padEnd(7),
    g.sport.toUpperCase().padEnd(7),
    String(g.samples).padEnd(6),
    g.avgSwing.toFixed(4).padEnd(9),
    g.consecRate.toFixed(3).padEnd(8),
    g.semiRate.toFixed(3).padEnd(8),
    g.matchup,
  );
}

// ── Bottom 10 (sanity check) ──────────────────────────────────────────────────
const bot10 = [...allGames].sort((a, b) => a.score - b.score).slice(0, 10);
console.log(`\n${'─'.repeat(80)}`);
console.log('BOTTOM 10 GAMES');
console.log('─'.repeat(80));
for (const g of bot10) {
  console.log(
    String(g.score).padEnd(7),
    g.sport.toUpperCase().padEnd(7),
    String(g.samples).padEnd(6),
    g.avgSwing.toFixed(4).padEnd(9),
    g.consecRate.toFixed(3).padEnd(8),
    g.semiRate.toFixed(3).padEnd(8),
    g.matchup,
  );
}

// ── Per-sport component averages ──────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log('AVERAGE COMPONENT CONTRIBUTION (by sport)');
for (const s of activeSports) {
  const gs  = allGames.filter(g => g.sport === s);
  const m   = ACTION_MULTIPLIERS[s] ?? ACTION_MULTIPLIERS.mlb;
  const avg = (gs.reduce((a, g) => a + g.score, 0) / gs.length).toFixed(1);
  const sw  = (gs.reduce((a, g) => a + g.avgSwing * m.avgSwing, 0) / gs.length).toFixed(1);
  const cr  = (gs.reduce((a, g) => a + g.consecRate * m.consecRate, 0) / gs.length).toFixed(1);
  const sr  = (gs.reduce((a, g) => a + g.semiRate * m.semiRate, 0) / gs.length).toFixed(1);
  console.log(`  ${ALL_SPORTS[s].name.padEnd(20)} avg=${avg}  swing=${sw} (${(sw/avg*100).toFixed(0)}%)  consec=${cr} (${(cr/avg*100).toFixed(0)}%)  semi=${sr} (${(sr/avg*100).toFixed(0)}%)`);
}
console.log('');
